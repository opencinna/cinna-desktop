/**
 * Reading an ACP runtime's usage reports into session telemetry
 * (`shared/sessionTelemetry.ts`): the prompt response's `usage` and
 * `_meta.quota`, the `usage_update` frames the translator hands over, and the
 * login the adapter says it is running on.
 *
 * Engine-specific facts, verified against the pinned adapters:
 *
 * - **Claude (`claude-agent-acp` 0.76.0).** The prompt response's `usage` is
 *   the turn's main loop only; `_meta.quota.model_usage[]` is the same turn
 *   split by model with subagents and compaction included, so it is the fuller
 *   figure and the one used. `usage_update.cost.amount` is the SDK's
 *   `total_cost_usd` — a running total for the session, which the CLI
 *   persists in the transcript (`cost-state`) and restores on resume — so a
 *   turn's cost is what the reading grew by ({@link costDelta}), measured
 *   after a restart against the last reading the chat's telemetry kept.
 *   The adapter's `model_usage` baseline does *not* survive: each session
 *   object it creates on `session/load` starts `lastModelUsageReading` at
 *   `{}`, so the first result's rows are the whole restored history. That
 *   turn's tokens come from `usage` instead ({@link TurnTelemetry.resumed}).
 * - **Codex (`codex-acp`).** The same response shape, but both `usage` and
 *   `_meta.quota` hold the turn's **last request** only (`tokenUsage.last`).
 *   Recorded as `tokenScope: 'last_request'`. No cost.
 *
 * - **Claude's raw SDK stream** (`acpSdkTelemetry.ts`, requested by the
 *   launcher) adds what the ACP surface does not carry: the resolved model
 *   from the first request, each main-agent request's time and cache-write
 *   TTL, and per result the per-model running cost, context window and max
 *   output, API time (a running total like the cost, measured against this
 *   process's earlier reading only) and request count. A follow-up turn (no prompt
 *   response) takes its tokens from the raw `result`'s `usage`.
 * - **Codex cost is estimated** from `shared/modelPricing.ts` (the runtime
 *   reports none) — a lower bound while its tokens are the last request's.
 *
 * Nothing here keeps or logs an account email or organisation: the auth
 * payload is read for its kind, a scrubbed label and the plan name.
 */

import { createHash } from 'node:crypto'
import type { CodexAuthStatus } from '../../../../shared/engine'
import { canonicalPricingModel, costOf, type CacheTtl } from '../../../../shared/modelPricing'
import {
  EMPTY_TOKEN_TALLY,
  type AuthKind,
  type MessageTelemetry,
  type SessionTelemetryAuth,
  type SessionTelemetryReporter,
  type TelemetryEngine,
  type TokenScope,
  type TokenTally
} from '../../../../shared/sessionTelemetry'
import { createLogger } from '../../../logger/logger'
import { sdkFrameLabel } from './acpSdkTelemetry'
import type { AcpConnection, AcpLauncherId, AcpSdkFrame, AcpTelemetryFrame } from './types'

const logger = createLogger('acp-telemetry')

/** The engines whose usage reports are read. Everything else reports none. */
export function telemetryEngineOf(launcher: AcpLauncherId): TelemetryEngine | null {
  return launcher === 'claude' || launcher === 'codex' ? launcher : null
}

/* ------------------------------------------------------------------- cost */

/**
 * What one turn cost, from one `usage_update.cost.amount` reading and the
 * previous reading for the same session (this process's, else the one the
 * chat's telemetry persisted).
 *
 * The reading is taken to be a **running total** (the SDK's `total_cost_usd`
 * accumulates over the session and is restored on resume). So the turn's
 * cost is the growth; a reading that dropped (a session whose total started
 * over), or a session with no earlier reading anywhere, is taken as is.
 *
 * If live data shows the amount is per result instead, return `reading` here
 * and nothing else changes.
 */
export function costDelta(previous: number | undefined, reading: number): number {
  if (previous === undefined || reading < previous) return reading
  return reading - previous
}

/**
 * The last cost reading per session, per connection. A connection with no
 * reading for a session (a new process, the session resumed) asks `persisted`
 * for the last one the chat's telemetry kept.
 */
export class CostReadings {
  private readonly readings = new WeakMap<AcpConnection, Map<string, number>>()

  /** Records `reading` and answers what it added (see {@link costDelta}). */
  take(connection: AcpConnection, sessionId: string, reading: number, persisted?: (sessionId: string) => number | undefined): number {
    let sessions = this.readings.get(connection)
    if (!sessions) {
      sessions = new Map()
      this.readings.set(connection, sessions)
    }
    const previous = sessions.has(sessionId) ? sessions.get(sessionId) : persisted?.(sessionId)
    const delta = costDelta(previous, reading)
    sessions.set(sessionId, reading)
    return delta
  }
}

export const costReadings = new CostReadings()

/**
 * The same bookkeeping per model, for the raw `result.modelUsage[m].costUSD`
 * readings — running totals for the session's query, like `total_cost_usd`.
 * A connection that has readings for the session measures a model it has
 * none for from zero; one that has none asks `persisted`.
 */
export class ModelCostReadings {
  private readonly readings = new WeakMap<AcpConnection, Map<string, Record<string, number>>>()

  /** Records `readings` and answers what each model's added (see {@link costDelta}). */
  take(
    connection: AcpConnection,
    sessionId: string,
    readings: Record<string, number>,
    persisted?: (sessionId: string) => Record<string, number> | undefined
  ): Record<string, number> {
    let sessions = this.readings.get(connection)
    if (!sessions) {
      sessions = new Map()
      this.readings.set(connection, sessions)
    }
    const previous = sessions.get(sessionId) ?? persisted?.(sessionId) ?? {}
    const deltas: Record<string, number> = {}
    for (const [model, reading] of Object.entries(readings)) deltas[model] = costDelta(previous[model], reading)
    sessions.set(sessionId, { ...previous, ...readings })
    return deltas
  }
}

export const modelCostReadings = new ModelCostReadings()

/**
 * The raw `result.duration_api_ms` readings, per session, per connection. Like
 * `total_cost_usd` it comes from the CLI's cumulative cost ledger, so it is a
 * running total for the session, not the result's own time. In memory only:
 * a connection with no reading for a session has nothing to measure against,
 * and the turn's API time stays unknown rather than guessed.
 */
export class ApiDurationReadings {
  private readonly readings = new WeakMap<AcpConnection, Map<string, number>>()

  /** The last reading this connection saw for the session, or undefined. */
  last(connection: AcpConnection, sessionId: string): number | undefined {
    return this.readings.get(connection)?.get(sessionId)
  }

  record(connection: AcpConnection, sessionId: string, reading: number): void {
    let sessions = this.readings.get(connection)
    if (!sessions) {
      sessions = new Map()
      this.readings.set(connection, sessions)
    }
    sessions.set(sessionId, reading)
  }
}

export const apiDurationReadings = new ApiDurationReadings()

/** How far the table's price may drift from the runtime's cost before it is logged. */
export const CALIBRATION_TOLERANCE = 0.05

/**
 * The price table checked against Claude's runtime cost, turn by turn. A
 * drift above {@link CALIBRATION_TOLERANCE} is logged once per model per
 * process — a stale table shows in the logs, not silently in the UI. The log
 * names the model and the two figures, nothing else.
 */
export class PriceCalibration {
  private readonly warned = new Set<string>()

  /** True when this call logged. */
  check(model: string, estimatedUsd: number | undefined, runtimeUsd: number | undefined): boolean {
    if (estimatedUsd === undefined || runtimeUsd === undefined || runtimeUsd <= 0) return false
    const canonical = canonicalPricingModel(model)
    if (this.warned.has(canonical)) return false
    if (Math.abs(estimatedUsd - runtimeUsd) / runtimeUsd <= CALIBRATION_TOLERANCE) return false
    this.warned.add(canonical)
    logger.warn('the price table drifts from the runtime’s cost for a model', {
      model: canonical,
      estimatedUsd: Number(estimatedUsd.toPrecision(6)),
      runtimeUsd: Number(runtimeUsd.toPrecision(6))
    })
    return true
  }
}

export const priceCalibration = new PriceCalibration()

/**
 * The sessions each connection has run a prompt on, or created, with the
 * fingerprint of the params they were last set up under. A session
 * `session/load`ed on a connection where it is not in here is a fresh adapter
 * session object over a restored history ({@link TurnTelemetry.resumed}). So
 * is one loaded under a different fingerprint: `claude-agent-acp` tears a live
 * session down and recreates it when its cwd or MCP servers change
 * (`getOrCreateSession`), which resets its model-usage baseline just the same.
 * The adapter's other rebuilds (a signed-out query, a provider update) are not
 * seen, and count as live.
 */
const liveSessions = new WeakMap<AcpConnection, Map<string, string>>()

/** What `claude-agent-acp` compares to decide a load must rebuild the session (its `computeSessionFingerprint`). */
export function sessionFingerprint(params: { cwd: string; mcpServers?: ReadonlyArray<{ name: string }> }): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers })
}

export function noteSessionLive(connection: AcpConnection, sessionId: string, fingerprint: string): void {
  let sessions = liveSessions.get(connection)
  if (!sessions) {
    sessions = new Map()
    liveSessions.set(connection, sessions)
  }
  sessions.set(sessionId, fingerprint)
}

export function isSessionLive(connection: AcpConnection, sessionId: string, fingerprint: string): boolean {
  return liveSessions.get(connection)?.get(sessionId) === fingerprint
}

/**
 * What telemetry keeps of a {@link sessionFingerprint}: a digest. The
 * fingerprint itself holds the MCP servers' env and headers, which can be
 * secrets, and is never stored.
 */
export function fingerprintDigest(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
}

/* -------------------------------------------------------- prompt response */

export interface PromptTelemetry {
  /** The main agent's resolved model (see {@link mainModel}). */
  model?: string
  tokens: TokenTally
  byModel: Record<string, TokenTally>
  tokenScope: TokenScope
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** `_meta.quota`'s `token_count` shape (codex's, which the Claude adapter copies). */
function tallyOfQuota(value: unknown): TokenTally | null {
  const q = record(value)
  if (!q) return null
  return {
    input: count(q.inputTokens),
    output: count(q.outputTokens),
    cacheRead: count(q.cachedInputTokens),
    cacheWrite: count(q.cachedWriteTokens)
  }
}

/** The ACP prompt response's `usage` shape. */
function tallyOfUsage(value: unknown): TokenTally | null {
  const u = record(value)
  if (!u) return null
  return {
    input: count(u.inputTokens),
    output: count(u.outputTokens),
    cacheRead: count(u.cachedReadTokens),
    cacheWrite: count(u.cachedWriteTokens)
  }
}

export function addTally(a: TokenTally, b: TokenTally): TokenTally {
  const sum: TokenTally = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  }
  if (a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined) sum.cacheWrite1h = (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0)
  return sum
}

/** A model id without its date and bracketed suffixes: `claude-sonnet-5[1m]` → `claude-sonnet-5`. */
export function canonicalModelId(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
}

/**
 * The main agent's model among a turn's per-model rows: the row whose
 * canonical id is the selected model's, else the one that read the most
 * context (input plus cache) — a subagent on a smaller model reads less.
 */
export function mainModel(rows: Record<string, TokenTally>, selected?: string): string | undefined {
  const models = Object.keys(rows)
  if (selected) {
    const wanted = canonicalModelId(selected)
    const match = models.find((model) => canonicalModelId(model) === wanted)
    if (match) return match
  }
  let best: string | undefined
  let bestRead = -1
  for (const model of models) {
    const t = rows[model]
    const read = t.input + t.cacheRead + t.cacheWrite
    if (read > bestRead) {
      best = model
      bestRead = read
    }
  }
  return best
}

/**
 * A prompt response's usage, for either engine. Null when it carries none.
 *
 * Claude: the tokens are the sum of `_meta.quota.model_usage[]` (subagents and
 * compaction included), falling back to `usage` (main loop) and then
 * `quota.token_count`. With `mainLoopOnly` (the first turn of a resumed
 * session, whose rows are its whole history) `usage` is taken instead and no
 * per-model rows are kept; the rows still name the model. Codex: `usage`,
 * falling back to `quota.token_count`; both are the last request only.
 */
export function parsePromptTelemetry(
  response: unknown,
  engine: TelemetryEngine,
  selectedModel?: string,
  options: { mainLoopOnly?: boolean } = {}
): PromptTelemetry | null {
  const r = record(response)
  if (!r) return null
  const quota = record(record(r._meta)?.quota)
  const byModel: Record<string, TokenTally> = {}
  const rows = Array.isArray(quota?.model_usage) ? quota.model_usage : []
  for (const row of rows) {
    const entry = record(row)
    const model = typeof entry?.model === 'string' && entry.model !== '' ? entry.model : null
    const tally = tallyOfQuota(entry?.token_count)
    if (!model || !tally) continue
    byModel[model] = byModel[model] ? addTally(byModel[model], tally) : tally
  }
  const summed = Object.values(byModel).reduce<TokenTally | null>((sum, tally) => (sum ? addTally(sum, tally) : tally), null)
  const usage = tallyOfUsage(r.usage)
  const total = tallyOfQuota(quota?.token_count)
  const mainLoopOnly = engine === 'claude' && options.mainLoopOnly === true
  const tokens = mainLoopOnly ? usage ?? total : engine === 'claude' ? summed ?? usage ?? total : usage ?? total ?? summed
  if (!tokens) return null
  const model = mainModel(byModel, selectedModel)
  return {
    ...(model ? { model } : {}),
    tokens,
    byModel: mainLoopOnly ? {} : byModel,
    tokenScope: engine === 'claude' ? 'turn' : 'last_request'
  }
}

/* ------------------------------------------------------------------- auth */

/** What the adapter's `_auth/status_update` said, minus the account. */
export interface ConnectionAuth {
  /** The adapter's own kind (`account`, `api_key`, `gateway`, `external`, `none`). */
  kind: string
  label: string | null
  plan?: string
}

/**
 * A string with anything email-shaped taken out of it.
 *
 * The label observed is a plan name (`Claude Max`), but the payload it arrives
 * in carries the account's email two fields away, and the one thing this driver
 * promises about that payload is that it does not pass the address on. A guard
 * rather than a comment, because the promise has to survive an adapter version
 * that decides the label should name the account.
 */
export function scrubbed(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '…')
}

/**
 * The kind of login the agent reported, its label and plan — never the account.
 *
 * Structural, and deliberately narrow: it reads three strings out of a payload
 * that also carries an email address and an organisation. Anything else in
 * there stays where it is.
 */
export function readAuthStatus(params: Record<string, unknown>): ConnectionAuth | null {
  const status = record(params.authStatus)
  if (!status) return null
  const kind = status.kind
  if (typeof kind !== 'string' || kind === '') return null
  const label = status.label
  const plan = record(status.account)?.plan
  return {
    kind,
    label: typeof label === 'string' && label !== '' ? scrubbed(label) : null,
    ...(typeof plan === 'string' && plan !== '' ? { plan: scrubbed(plan) } : {})
  }
}

/**
 * The adapter's kind as a telemetry {@link AuthKind}. `claude-agent-acp`
 * (`auth-status.js`) sends `account` (a claude.ai subscription), `api_key`,
 * `gateway`, `external` (Bedrock, Vertex, Foundry…) and `none`.
 */
export function authKindOf(kind: string): AuthKind {
  const k = kind.toLowerCase().replace(/[-\s]/g, '_')
  if (k === 'account' || k === 'subscription') return 'subscription'
  if (k === 'api_key' || k === 'apikey') return 'api_key'
  if (k === 'gateway') return 'gateway'
  if (k === 'external' || k === 'cloud' || /bedrock|vertex|foundry|aws|google/.test(k)) return 'cloud'
  if (k === 'none') return 'none'
  return 'unknown'
}

export function telemetryAuthOf(auth: ConnectionAuth): SessionTelemetryAuth {
  return {
    kind: authKindOf(auth.kind),
    ...(auth.label ? { label: auth.label } : {}),
    ...(auth.plan ? { plan: auth.plan } : {})
  }
}

/** Codex's `codex login status`: ChatGPT is a subscription, an API key is one. */
export function codexTelemetryAuth(status: CodexAuthStatus): SessionTelemetryAuth {
  if (status.state === 'logged_out') return { kind: 'none' }
  if (status.method === 'chatgpt') return { kind: 'subscription', label: 'ChatGPT' }
  if (status.method === 'api_key') return { kind: 'api_key', label: 'OpenAI API key' }
  return { kind: 'unknown' }
}

/** The adapter's own notification about which login is paying. */
export const AUTH_STATUS_METHOD = '_auth/status_update'

const connectionAuth = new WeakMap<AcpConnection, ConnectionAuth>()
const watched = new WeakSet<AcpConnection>()

/** Record an `_auth/status_update` for a connection, whichever way it arrived. */
export function noteConnectionAuth(connection: AcpConnection, params: Record<string, unknown>): void {
  const auth = readAuthStatus(params)
  if (auth) connectionAuth.set(connection, auth)
}

/**
 * Listen to a connection's session-less notifications for its login, once per
 * connection. The first listener also gets what arrived before it.
 */
export function watchConnectionAuth(connection: AcpConnection): void {
  if (watched.has(connection) || !connection.onConnectionExt) return
  watched.add(connection)
  try {
    connection.onConnectionExt((method, params) => {
      if (method === AUTH_STATUS_METHOD) noteConnectionAuth(connection, params)
    })
  } catch (err) {
    logger.warn('could not listen to a connection’s notifications', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** The latest login the connection reported, or null. */
export function connectionAuthOf(connection: AcpConnection | undefined): ConnectionAuth | null {
  return connection ? connectionAuth.get(connection) ?? null : null
}

/* ----------------------------------------------------------- one turn */

export interface TurnTelemetryOptions {
  engine: TelemetryEngine
  chatId: string
  /** Absent: nothing is reported (a nested turn), the result still carries its telemetry. */
  reporter?: SessionTelemetryReporter
  now?: () => number
  costs?: CostReadings
  modelCosts?: ModelCostReadings
  apiDurations?: ApiDurationReadings
  calibration?: PriceCalibration
  /** The last cost reading the chat's telemetry kept for a session (see {@link CostReadings}). */
  lastCostReading?: (sessionId: string) => number | undefined
  /** The same per model (see {@link ModelCostReadings}). */
  lastModelCostReadings?: (sessionId: string) => Record<string, number> | undefined
}

/** The SDK's `apiKeySource` values that mean an API key paid. `none` says nothing (OAuth, a bearer token, a cloud). */
const API_KEY_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key'])

/** The key among `keys` naming the same model as `model`, exact first. */
function sameModel(keys: string[], model: string | undefined): string | undefined {
  if (!model) return undefined
  if (keys.includes(model)) return model
  const wanted = canonicalPricingModel(model)
  return keys.find((key) => canonicalPricingModel(key) === wanted)
}

/**
 * What one turn — prompted or a follow-up — observed, settled once into its
 * {@link MessageTelemetry} and reported to the session once.
 *
 * Context readings and raw-stream facts (init, main-agent requests,
 * compaction) are reported as they arrive; the turn's tokens and cost only
 * at {@link settle}. The caller drops a load replay's frames before they get
 * here.
 */
export class TurnTelemetry {
  private selected?: string
  private reportedSelected?: string
  private costUsd?: number
  private lastUsed?: number
  private startedAt?: number
  private endedAt?: number
  private answer?: unknown
  private settled = false
  private mainLoopOnly = false
  private result?: MessageTelemetry
  private authKind?: SessionTelemetryAuth['kind']
  // Claude's raw stream.
  private rawModel?: string
  private fastMode?: string
  private readonly requestIds = new Set<string>()
  private requests = 0
  private ttl?: CacheTtl
  private maxRequestInput?: number
  private rawUsage?: TokenTally
  private numTurns?: number
  /** The session's API-time reading before the turn's first result: `null` when this process had none. */
  private apiDurationBefore?: number | null
  private apiDurationLatest?: number
  private readonly modelCostDelta: Record<string, number> = {}
  private readonly modelCostLatest: Record<string, number> = {}
  private readonly modelCostBasis: Record<string, string> = {}
  private contextWindow?: number
  private maxOutputTokens?: number
  private readonly traffic: Record<string, { frames: number; bytes?: number }> = {}
  private readonly now: () => number
  private readonly costs: CostReadings
  private readonly modelCosts: ModelCostReadings
  private readonly apiDurations: ApiDurationReadings
  private readonly calibration: PriceCalibration

  constructor(private readonly options: TurnTelemetryOptions) {
    this.now = options.now ?? Date.now
    this.costs = options.costs ?? costReadings
    this.modelCosts = options.modelCosts ?? modelCostReadings
    this.apiDurations = options.apiDurations ?? apiDurationReadings
    this.calibration = options.calibration ?? priceCalibration
  }

  get engine(): TelemetryEngine {
    return this.options.engine
  }

  private report(change: Parameters<SessionTelemetryReporter['report']>[1]): void {
    if (!this.options.reporter) return
    try {
      this.options.reporter.report(this.options.chatId, change)
    } catch (err) {
      logger.warn('session telemetry could not be reported', { chatId: this.options.chatId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** The session's model option, from a `session/new`/`load` answer or a `config_option_update`. */
  model(selected: string | undefined): void {
    if (!selected) return
    this.selected = selected
    if (selected === this.reportedSelected) return
    this.reportedSelected = selected
    this.report({ type: 'model', engine: this.options.engine, selected })
  }

  /**
   * The turn's ACP session was created (`fresh`) or loaded, under the params
   * whose {@link sessionFingerprint} is `fingerprint`. Only a digest goes on.
   * A session this connection created starts its API-time ledger at zero, so
   * its first turn's API time is known rather than left unset.
   */
  session(sessionId: string, fresh: boolean, fingerprint: string, connection?: AcpConnection): void {
    if (fresh && connection) this.apiDurations.record(connection, sessionId, 0)
    this.report({ type: 'session', engine: this.options.engine, sessionId, fresh, fingerprint: fingerprintDigest(fingerprint), at: this.now() })
  }

  /**
   * The turn runs on a session `session/load` restored into a fresh adapter
   * session object. Claude's `_meta.quota.model_usage` is then measured from
   * zero, so it holds the whole restored history, not this turn: the turn's
   * tokens come from the response's `usage` (main loop only, subagents and
   * compaction not counted) — an undercount rather than a double count.
   */
  resumed(): void {
    this.mainLoopOnly = true
  }

  /** One `usage_update` of the turn's own session (not a child session's). */
  frame(connection: AcpConnection, sessionId: string, frame: AcpTelemetryFrame): void {
    const costed = frame.costUsd !== undefined
    if (frame.costUsd !== undefined) {
      this.costUsd = (this.costUsd ?? 0) + this.costs.take(connection, sessionId, frame.costUsd, this.options.lastCostReading)
    }
    if (frame.used !== undefined) this.lastUsed = frame.used
    this.report({
      type: 'context',
      engine: this.options.engine,
      sessionId,
      ...(frame.used !== undefined ? { used: frame.used } : {}),
      ...(frame.size !== undefined ? { size: frame.size } : {}),
      costed,
      ...(frame.costUsd !== undefined ? { costReading: frame.costUsd } : {}),
      ...(frame.rateLimit !== undefined ? { rateLimit: frame.rateLimit } : {}),
      at: this.now(),
      ...(this.requests > 0 ? { cacheTimed: true } : {})
    })
  }

  /**
   * One raw SDK frame (`_claude/sdkMessage`) of the turn's own session.
   * A subagent's frame (`main: false`) is counted as traffic and read for
   * nothing else: it never moves the model, the context or the cache.
   */
  sdk(connection: AcpConnection, sessionId: string, frame: AcpSdkFrame): void {
    const label = sdkFrameLabel(frame)
    const seen = this.traffic[label] ?? { frames: 0 }
    // Sized only while debug detail is on (`readSdkMessage`).
    const bytes = frame.bytes !== undefined || seen.bytes !== undefined ? (seen.bytes ?? 0) + (frame.bytes ?? 0) : undefined
    this.traffic[label] = { frames: seen.frames + 1, ...(bytes !== undefined ? { bytes } : {}) }
    const engine = this.options.engine
    switch (frame.kind) {
      case 'init': {
        if (frame.model) this.rawModel = frame.model
        if (frame.fastMode) this.fastMode = frame.fastMode
        this.report({
          type: 'runtime',
          engine,
          sessionId,
          ...(frame.model ? { model: frame.model } : {}),
          ...(frame.cliVersion ? { cliVersion: frame.cliVersion } : {}),
          ...(frame.betas ? { betas: frame.betas } : {}),
          ...(frame.effort !== undefined ? { effort: frame.effort } : {}),
          ...(frame.fastMode ? { fastMode: frame.fastMode } : {}),
          ...(frame.apiKeySource && API_KEY_SOURCES.has(frame.apiKeySource) ? { authHint: 'api_key' as const } : {})
        })
        return
      }
      case 'assistant': {
        if (!frame.main) return
        if (frame.model) this.rawModel = frame.model
        // A streamed message arrives as one frame per content block, each
        // with the same id and the same input-side usage: one request.
        if (frame.messageId) {
          if (this.requestIds.has(frame.messageId)) return
          this.requestIds.add(frame.messageId)
        }
        this.requests += 1
        const usage = frame.usage
        const input = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0
        const write5m = usage?.cacheWrite5m ?? 0
        const write1h = usage?.cacheWrite1h ?? 0
        if (write1h > 0) this.ttl = '1h'
        else if (write5m > 0 && this.ttl === undefined) this.ttl = '5m'
        if (input > 0) this.maxRequestInput = Math.max(this.maxRequestInput ?? 0, input)
        this.report({
          type: 'request',
          engine,
          sessionId,
          ...(frame.model ? { model: frame.model } : {}),
          input,
          cacheWrite5m: write5m,
          cacheWrite1h: write1h,
          at: this.now()
        })
        return
      }
      case 'result': {
        if (frame.fastMode) this.fastMode = frame.fastMode
        if (frame.usage) {
          const tally: TokenTally = { input: frame.usage.input, output: frame.usage.output, cacheRead: frame.usage.cacheRead, cacheWrite: frame.usage.cacheWrite }
          if (frame.usage.cacheWrite1h !== undefined) tally.cacheWrite1h = frame.usage.cacheWrite1h
          this.rawUsage = this.rawUsage ? addTally(this.rawUsage, tally) : tally
        }
        if (frame.numTurns !== undefined) this.numTurns = (this.numTurns ?? 0) + frame.numTurns
        // A running total, like the cost: the turn's is the last reading
        // less the one before the turn, never a sum of readings.
        if (frame.apiDurationMs !== undefined) {
          if (this.apiDurationBefore === undefined) this.apiDurationBefore = this.apiDurations.last(connection, sessionId) ?? null
          this.apiDurations.record(connection, sessionId, frame.apiDurationMs)
          this.apiDurationLatest = frame.apiDurationMs
        }
        const readings: Record<string, number> = {}
        for (const [model, row] of Object.entries(frame.models)) {
          if (row.costUsd !== undefined) readings[model] = row.costUsd
          if (row.costBasis) this.modelCostBasis[model] = row.costBasis
        }
        if (Object.keys(readings).length) {
          const deltas = this.modelCosts.take(connection, sessionId, readings, this.options.lastModelCostReadings)
          for (const [model, delta] of Object.entries(deltas)) this.modelCostDelta[model] = (this.modelCostDelta[model] ?? 0) + delta
          Object.assign(this.modelCostLatest, readings)
        }
        // The window is the main model's; a subagent's model has its own.
        const models = Object.keys(frame.models)
        const main = sameModel(models, this.rawModel ?? this.selected) ?? (models.length === 1 ? models[0] : undefined)
        if (main) {
          const row = frame.models[main]
          if (row.contextWindow) this.contextWindow = row.contextWindow
          if (row.maxOutputTokens) this.maxOutputTokens = row.maxOutputTokens
        }
        return
      }
      case 'compact':
        this.report({ type: 'compaction', engine, sessionId, at: this.now() })
        return
      case 'other':
        return
    }
  }

  /** The login, reported to the session as it stands. */
  auth(auth: SessionTelemetryAuth | null): void {
    if (!auth) return
    this.authKind = auth.kind
    this.report({ type: 'auth', engine: this.options.engine, auth })
  }

  /** The prompt went out (or the follow-up began). */
  started(): void {
    if (this.startedAt === undefined) this.startedAt = this.now()
  }

  /** The prompt response, cancelled ones included. */
  answered(response: unknown): void {
    this.endedAt = this.now()
    this.answer = response
  }

  /** Per-model cost deltas keyed like the turn's token rows where the ids name the same model. */
  private costsByModel(rows: Record<string, TokenTally>): Record<string, number> {
    const keys = Object.keys(rows)
    const byModel: Record<string, number> = {}
    for (const [model, cost] of Object.entries(this.modelCostDelta)) {
      const key = sameModel(keys, model) ?? model
      byModel[key] = (byModel[key] ?? 0) + cost
    }
    return byModel
  }

  /**
   * Claude: each model's tokens at list price against what the runtime
   * charged for it. Not on a resumed session's first turn (its rows are not
   * the turn's), and not for a model the runtime priced other than at list.
   */
  private calibrate(rows: Record<string, TokenTally>): void {
    const models = Object.keys(rows)
    const costKeys = Object.keys(this.modelCostDelta)
    for (const model of models) {
      const costKey = sameModel(costKeys, model)
      let runtime: number | undefined
      if (costKey) {
        const basis = this.modelCostBasis[costKey]
        if (basis && basis !== 'list') continue
        runtime = this.modelCostDelta[costKey]
      } else if (models.length === 1 && costKeys.length === 0) {
        runtime = this.costUsd
      }
      const estimated = costOf(model, rows[model], {
        ttl: this.ttl ?? '5m',
        fast: this.fastMode === 'on',
        ...(this.maxRequestInput !== undefined ? { contextTokens: this.maxRequestInput } : {})
      })
      this.calibration.check(model, estimated, runtime)
    }
  }

  private logTraffic(): void {
    const labels = Object.keys(this.traffic)
    if (!labels.length) return
    let bytes: number | undefined
    for (const label of labels) {
      const sized = this.traffic[label].bytes
      if (sized !== undefined) bytes = (bytes ?? 0) + sized
    }
    logger.debug('raw SDK stream traffic for the turn', { chatId: this.options.chatId, ...(bytes !== undefined ? { bytes } : {}), byType: this.traffic })
  }

  /**
   * The turn's telemetry, or undefined when the runtime reported neither
   * tokens nor cost. The first call reports it to the session; later calls
   * answer the same value and report nothing.
   */
  settle(sessionId: string | null): MessageTelemetry | undefined {
    if (this.settled) return this.result
    this.settled = true
    this.logTraffic()
    const engine = this.options.engine
    const parsed = this.answer !== undefined ? parsePromptTelemetry(this.answer, engine, this.selected, { mainLoopOnly: this.mainLoopOnly }) : null
    // No prompt response (a follow-up the agent started): the raw result's
    // main-loop usage is the turn's.
    const raw = !parsed && this.rawUsage ? { tokens: this.rawUsage, model: this.rawModel } : null
    if (!parsed && !raw && this.costUsd === undefined) return undefined
    const model = parsed?.model ?? raw?.model
    const tokens = parsed?.tokens ?? raw?.tokens ?? { ...EMPTY_TOKEN_TALLY }
    const tokenScope: TokenScope = parsed ? parsed.tokenScope : raw ? 'turn' : 'none'
    const rows = parsed?.byModel ?? {}

    let costUsd = this.costUsd
    let costSource: MessageTelemetry['costSource'] = 'runtime'
    let byModelCost = this.costsByModel(rows)
    if (engine === 'claude' && parsed && !this.mainLoopOnly) this.calibrate(rows)
    // Codex reports no cost: the table's, unless a partner cloud paid (its
    // prices differ) or the model is not in it. A lower bound while the
    // tokens are the last request's.
    if (engine === 'codex' && costUsd === undefined && parsed && model && this.authKind !== 'cloud') {
      const estimated = costOf(model, tokens, { contextTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite })
      if (estimated !== undefined) {
        costUsd = estimated
        costSource = 'estimated'
        byModelCost = { [model]: estimated }
      }
    }

    const end = this.endedAt ?? this.now()
    const requests = this.numTurns ?? (this.requests > 0 ? this.requests : undefined)
    // No earlier reading in this process: the turn's API time is not known.
    const apiDurationMs =
      this.apiDurationLatest !== undefined && typeof this.apiDurationBefore === 'number'
        ? costDelta(this.apiDurationBefore, this.apiDurationLatest)
        : undefined
    const message: MessageTelemetry = {
      ...(model ? { model } : {}),
      tokens,
      tokenScope,
      ...(costUsd !== undefined ? { costUsd } : {}),
      costSource,
      ...(requests !== undefined ? { requests } : {}),
      ...(this.startedAt !== undefined ? { durationMs: Math.max(0, end - this.startedAt) } : {}),
      ...(apiDurationMs !== undefined ? { apiDurationMs } : {}),
      ...(this.lastUsed !== undefined ? { contextUsedAfter: this.lastUsed } : {})
    }
    this.result = message
    if (sessionId) {
      this.report({
        type: 'turn',
        engine,
        sessionId,
        message,
        ...(Object.keys(rows).length ? { byModel: rows } : {}),
        ...(Object.keys(byModelCost).length ? { byModelCost } : {}),
        ...(Object.keys(this.modelCostLatest).length ? { modelCostReadings: { ...this.modelCostLatest } } : {}),
        ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
        ...(this.maxOutputTokens !== undefined ? { maxOutputTokens: this.maxOutputTokens } : {}),
        ...(this.selected ? { selectedModel: this.selected } : {})
      })
    }
    return message
  }
}
