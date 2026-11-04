/**
 * Whether a tile's data is fresh, and recomputing it when it is not. Main owns
 * freshness: the renderer only says "these tiles are on screen" (a lease it
 * renews) and "Refresh was pressed".
 *
 * - **Re-read versus recompute.** The last good result per (tile, params) is
 *   cached in the DB and shown at once (stale-while-revalidate). A recompute
 *   runs the source: an endpoint through {@link endpointRunner}, or a file
 *   source re-read after its `refresh.command` (`/run:<name>`, with the
 *   yielding lock) when it has one.
 * - **When (D1).** On screen and older than the tile's max age (`visible`), or
 *   Refresh (`manual`). A tile set to Manual recomputes on its own only while
 *   it has no data yet.
 * - **After a turn (D3).** When a turn of an agent ends, each of its tiles
 *   that holds a live lease is asked again with `after_turn`. A plain file
 *   source (no `refresh.command`) is re-read, which costs nothing; anything
 *   that would run a script recomputes only where the component says
 *   `refresh.after_turn: true`. A tile set to Manual that has data, or that
 *   nobody is looking at, runs nothing.
 * - **Credentials first (D16).** A component whose `requires_credentials`
 *   names a slot not ready for the agent runs nothing: the answer carries a
 *   sentence naming the credential(s), stored nowhere.
 * - **A skill's component** (D15) runs its script from the skill's folder,
 *   by absolute path, with cwd and credentials at the agent that has it.
 * - **A failure keeps the data** and stores the error beside it. A busy agent
 *   (an exclusive folder write held or queued) keeps the data and skips the
 *   tick, with no error; so does a run an exclusive write preempted mid-run
 *   (`interrupted`) — the next refresh simply runs it again.
 * - **Output is data.** A file source's values are redacted as an endpoint's
 *   are, before they are cached or shown.
 * - **In flight** runs are joined per (tile, params hash): a second request
 *   with the same params gets the running one; new params supersede it.
 * - **The lease.** Renewed every 20 s by the renderer for the tiles on screen
 *   and dropped on hide or blur; a renewal re-checks those tiles. Core cannot
 *   see window state, so a reloaded or hidden renderer simply stops renewing.
 * - **The effective rule (D4).** The component's `refresh` with the tile's
 *   override over it, field by field ({@link effectiveRefresh}); max age,
 *   Manual, after-turn, the interval and on-app-start all read it.
 * - **While open (`interval`).** A tile with an effective `while_open_every`
 *   gets a main-owned timer while it holds a live lease; the timer stops when
 *   the lease lapses or drops, or the profile closes. No lease, no timer.
 * - **Launch warm-up (`launch`).** Once the profile is ready, every tile
 *   whose effective `on_app_start` is true recomputes, one at a time, unless
 *   its cache is younger than its max age. `CINNA_DASHBOARD_WARMUP=off`
 *   turns it off; a profile close or quit cancels it.
 * - **Params (`params`).** Changing a tile's params always recomputes.
 * - **Schedule-fed tiles (`schedule`).** When the schedule a component names
 *   in `refresh.schedule` completes a run, each of its tiles on this
 *   profile's dashboards runs its source once, lease or not: the schedule
 *   wrote what the source reads. A file source is re-read without its
 *   `refresh.command`; Refresh on such a tile does the same (there is no
 *   "run the schedule now").
 * - **Drill-downs (`call`).** `tools/call` from a page runs one of the
 *   component's own endpoints once, never cached; the newest call per
 *   (target, endpoint) wins; at most `DASHBOARD_CALLS_PER_MINUTE` per tile or
 *   preview target in any sliding minute; credentials and the endpoint's
 *   timeout as for refreshes.
 * - **Profile close** cancels every run, timer and warm-up and drops every lease.
 *
 * Core module: no Electron. Pushes `dashboards:tile-changed {tileId}` through
 * `host/events`.
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { dashboardRepo } from '../../db/dashboards'
import { publishEvent } from '../../host/events'
import { getSettingsScopeUserId } from '../../auth/scope'
import { createLogger } from '../../logger/logger'
import { capabilityService } from '../capabilityService'
import { isCredentialFilePath } from '../../../shared/agentFiles'
import { redactCredentialValues } from '../../security/serviceCredentialRedaction'
import { commandService } from '../localAgents/commandService'
import { RUN_REFERENCE_PATTERN } from '../../../shared/kit/manifest'
import { dashboardsFolderRole, type ComponentAgent, type ScannedComponent } from './componentScanner'
import { dashboardService, type DashboardService } from './dashboardService'
import { checkCallParams, effectiveRefresh, normalizeTileParams, type EffectiveRefresh } from './tileParams'
import { DASHBOARD_LOCK_OWNER, MAX_ENDPOINT_STDOUT_BYTES, endpointRunner, type EndpointOutcome, type EndpointRunner } from './endpointRunner'
import {
  DASHBOARDS_TILE_CHANGED_CHANNEL,
  DASHBOARD_CALLS_PER_MINUTE,
  DASHBOARD_LEASE_TTL_MS,
  resolveParamWords,
  type DashboardCallOutcome,
  type DashboardRefreshReason,
  type DashboardsOutcome,
  type TileDto,
  type TileResultDto
} from '../../../shared/dashboards'

const logger = createLogger('dashboard-refresh')

/** A result over this (as JSON) is shown but not kept: the tile says "too large to keep". */
export const MAX_CACHED_RESULT_BYTES = 1_000_000

/** Tile ids one lease renewal takes; the rest are ignored. */
export const MAX_LEASED_TILES = 100

/** A file source larger than this is not read. */
const MAX_FILE_SOURCE_BYTES = MAX_ENDPOINT_STDOUT_BYTES

type SourceOutcome = EndpointOutcome

const REFRESH_REASONS: readonly DashboardRefreshReason[] = ['visible', 'manual', 'after_turn', 'interval', 'launch', 'params', 'schedule']

/** The window `DASHBOARD_CALLS_PER_MINUTE` counts over. */
export const CALL_RATE_WINDOW_MS = 60_000

/** Interval timers, injectable for tests. */
export interface RefreshTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const nodeTimers: RefreshTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    // A tile's interval never keeps a Node host alive on its own.
    if (typeof handle === 'object' && handle && 'unref' in handle) (handle as { unref: () => void }).unref()
    return handle
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

export interface RefreshServiceDeps {
  dashboards: Pick<DashboardService, 'resolveTile' | 'resolveComponent' | 'placements' | 'setParams' | 'list' | 'tiles'>
  runner: Pick<EndpointRunner, 'run'>
  /** A file source's `refresh.command`, through `/run:` with the yielding lock. */
  runCommand: (agentId: string, name: string, signal: AbortSignal) => Promise<{ ok: boolean; busy: boolean; aborted: boolean; error?: string }>
  publish: (tileId: string) => void
  now?: () => number
  timers?: RefreshTimers
  /** Whether the launch warm-up is off (`CINNA_DASHBOARD_WARMUP=off`). */
  warmupDisabled?: () => boolean
  /**
   * Whether Dashboards is on (Settings → Features → Capabilities). Off, nothing
   * runs in the background: no warm-up, no interval timer, no schedule-fed run.
   * Asked at each of those moments, so turning it on takes effect at the next
   * one (a lease renewal arms timers within 20 s; warm-up waits for the next
   * profile start). What the user or an agent asks for directly still runs.
   */
  enabled?: () => boolean
}

/** A sentence for an endpoint call that gave no value, as a page reads it. */
function callFailureMessage(outcome: Extract<EndpointOutcome, { ok: false }>): string {
  switch (outcome.code) {
    case 'superseded':
      return 'A newer call to this endpoint replaced this one.'
    case 'busy':
      return 'The agent is busy with a change to its folder; try again in a moment.'
    case 'cancelled':
      return 'The call was cancelled.'
    default:
      return outcome.message
  }
}

/** The hash a tile's cached result is keyed by: its params, keys sorted. */
export function paramsHash(params: Record<string, unknown>): string {
  const sorted = Object.keys(params).sort().reduce<Record<string, unknown>>((out, key) => { out[key] = params[key]; return out }, {})
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32)
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

/** A file source, read: JSON as is, markdown and CSV as `{markdown}` / `{csv}`. */
async function readFileSource(agentDir: string, relPath: string): Promise<SourceOutcome> {
  const startedAt = Date.now()
  const fail = (message: string): SourceOutcome => ({ ok: false, code: 'failed', message, durationMs: Date.now() - startedAt })
  let real: string
  let agentReal: string
  try {
    agentReal = await realpath(agentDir)
    real = await realpath(join(agentReal, relPath))
  } catch {
    return fail(`${relPath} is not there yet.`)
  }
  if (!isWithin(agentReal, real) || isCredentialFilePath(real, agentReal)) return fail(`${relPath} cannot be read.`)
  try {
    const info = await stat(real)
    if (!info.isFile()) return fail(`${relPath} is not a file.`)
    if (info.size > MAX_FILE_SOURCE_BYTES) return { ok: false, code: 'too_large', message: `${relPath} is too large (over 5 MB).`, durationMs: Date.now() - startedAt }
    const text = await readFile(real, 'utf8')
    const ext = extname(real).toLowerCase()
    if (ext === '.json') {
      try {
        return { ok: true, value: redactCredentialValues(JSON.parse(text) as unknown), durationMs: Date.now() - startedAt }
      } catch {
        return { ok: false, code: 'not_json', message: `${relPath} is not valid JSON.`, durationMs: Date.now() - startedAt }
      }
    }
    return { ok: true, value: redactCredentialValues(ext === '.csv' ? { csv: text } : { markdown: text }), durationMs: Date.now() - startedAt }
  } catch {
    return fail(`${relPath} could not be read.`)
  }
}

/** The sentence for a tile's params change or a preview's params run over the per-minute budget. */
function rateLimitedMessage(target: 'tile' | 'preview'): string {
  return `This ${target} ran its endpoints more than ${DASHBOARD_CALLS_PER_MINUTE} times in a minute; wait a moment and try again.`
}

/** The sentence a tile or preview shows when credentials are missing; names each one. */
export function missingCredentialsMessage(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`)
  const list = quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
  return quoted.length === 1
    ? `This needs the ${list} credential, which is not set up for this agent yet.`
    : `This needs the ${list} credentials, which are not set up for this agent yet.`
}

function notice(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const value = (data as Record<string, unknown>).notice
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
}

function parse(json: string | null): unknown {
  if (json === null) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function createDashboardRefreshService(deps: RefreshServiceDeps) {
  const now = deps.now ?? Date.now
  const enabled = deps.enabled ?? (() => true)
  /** Runs in flight, per `${tileId}|${paramsHash}`. */
  const inFlight = new Map<string, Promise<void>>()
  /** Every run's controller, so a profile close can stop them all. */
  const controllers = new Set<AbortController>()
  /** Every run and preview still going, so a quit can wait for their processes to end. */
  const pending = new Set<Promise<unknown>>()
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => {})
    return work
  }
  /** Results over the cache limit, kept in memory only: `${tileId}|${hash}`. */
  const uncached = new Map<string, unknown>()
  const leases = new Map<string, { userId: string; expiresAt: number }>()
  let epoch = 0

  /** Interval timers per tile: the period they run at and the profile that leased them. */
  const timers = new Map<string, { handle: unknown; periodMs: number; userId: string }>()
  const clock = deps.timers ?? nodeTimers
  /** `tools/call` start times per target, for the sliding-minute limit. */
  const callTimes = new Map<string, number[]>()
  /** The running warm-up's cancel, if any. */
  let warmup: { cancelled: boolean } | null = null

  function rule(tile: TileDto, scanned: ScannedComponent | null): EffectiveRefresh {
    return effectiveRefresh(scanned?.spec, tile.refreshOverride)
  }

  function maxAgeMs(tile: TileDto, scanned: ScannedComponent | null): number {
    return rule(tile, scanned).maxAgeMs
  }

  function stopTimer(tileId: string): void {
    const timer = timers.get(tileId)
    if (!timer) return
    clock.clearInterval(timer.handle)
    timers.delete(tileId)
  }

  /** A leased tile's interval: started, restarted at a new period, or stopped when it has none. */
  function syncTimer(userId: string, tile: TileDto, scanned: ScannedComponent | null): void {
    const periodMs = scanned?.spec ? rule(tile, scanned).whileOpenEveryMs : null
    const existing = timers.get(tile.id)
    if (existing && existing.periodMs === periodMs && existing.userId === userId && enabled()) return
    stopTimer(tile.id)
    if (periodMs === null || !enabled()) return
    const handle = clock.setInterval(() => {
      // No lease, no timer: a lapsed or dropped lease stops it at its next tick,
      // and so does Dashboards being turned off.
      if (!service.isLeased(tile.id, userId) || !enabled()) {
        stopTimer(tile.id)
        return
      }
      void service.ensureFresh(userId, tile.id, 'interval').catch(() => {})
    }, periodMs)
    timers.set(tile.id, { handle, periodMs, userId })
  }

  /** The source's params: the tile's values over the component's defaults, `current`/`today` resolved. */
  function effectiveParams(tile: TileDto, scanned: ScannedComponent): Record<string, unknown> {
    return resolveParamWords(tile.params, scanned.spec?.params ?? {}, new Date(now()))
  }

  /** The command line of one of the component's endpoints, for the runner. */
  function endpointCall(agent: ComponentAgent, scanned: ScannedComponent, endpointName: string, params: Record<string, unknown>, key: string, signal: AbortSignal) {
    const endpoint = scanned.spec!.endpoints[endpointName]
    return {
      agentId: agent.id,
      agentDir: agent.path,
      rootPath: agent.rootPath,
      script: scanned.info.skill === null
        ? `${dashboardsFolderRole(agent.rootPath)}/${scanned.info.name}/${endpoint.script}`
        : join(scanned.dir, ...endpoint.script.split('/')),
      runtime: endpoint.runtime,
      params,
      timeoutS: endpoint.timeoutS,
      key,
      signal
    }
  }

  async function runSource(agent: ComponentAgent, scanned: ScannedComponent, params: Record<string, unknown>, key: string, signal: AbortSignal, options: { skipCommand?: boolean } = {}): Promise<SourceOutcome> {
    const spec = scanned.spec!
    if ('endpoint' in spec.source) {
      // The agent's own script runs agent-relative from the agent folder; a
      // skill's from the skill's folder (perhaps a cache outside the agent),
      // absolute. cwd and credentials stay the agent's.
      return deps.runner.run(endpointCall(agent, scanned, spec.source.endpoint, params, `${key}:${spec.source.endpoint}`, signal))
    }
    if (spec.refreshCommand && !options.skipCommand) {
      const name = RUN_REFERENCE_PATTERN.exec(spec.refreshCommand)?.[1]
      if (name) {
        const startedAt = Date.now()
        const ran = await deps.runCommand(agent.id, name, signal)
        if (ran.aborted) return { ok: false, code: 'cancelled', message: 'The run was cancelled.', durationMs: Date.now() - startedAt }
        if (ran.busy) return { ok: false, code: 'busy', message: 'The agent is busy; the tile keeps its data.', durationMs: Date.now() - startedAt }
        if (!ran.ok) return { ok: false, code: 'failed', message: ran.error ?? `${spec.refreshCommand} failed.`, durationMs: Date.now() - startedAt }
      }
    }
    return readFileSource(agent.path, spec.source.file)
  }

  /** What the tile shows now, from the cache and what is in flight. Runs nothing. */
  function resultFor(tile: TileDto, scanned: ScannedComponent | null, hash = paramsHash(tile.params)): TileResultDto {
    const row = dashboardRepo.result(tile.id, hash)
    const memKey = `${tile.id}|${hash}`
    const data = row?.tooLarge ? (uncached.get(memKey) ?? null) : parse(row?.resultJson ?? null)
    const fetchedAt = row?.fetchedAt ?? null
    return {
      tileId: tile.id,
      data,
      fetchedAt,
      error: row?.error ?? null,
      refreshing: inFlight.has(memKey),
      stale: fetchedAt === null || now() - fetchedAt > maxAgeMs(tile, scanned),
      tooLarge: row?.tooLarge ?? false,
      notice: notice(data)
    }
  }

  function record(tileId: string, hash: string, outcome: SourceOutcome): void {
    const memKey = `${tileId}|${hash}`
    try {
      if (outcome.ok) {
        const json = JSON.stringify(outcome.value) ?? 'null'
        if (Buffer.byteLength(json) > MAX_CACHED_RESULT_BYTES) {
          uncached.set(memKey, outcome.value)
          dashboardRepo.saveResult(tileId, hash, { resultJson: null, fetchedAt: now(), error: null, durationMs: outcome.durationMs, tooLarge: true }, now())
        } else {
          uncached.delete(memKey)
          dashboardRepo.saveResult(tileId, hash, { resultJson: json, fetchedAt: now(), error: null, durationMs: outcome.durationMs }, now())
        }
      } else {
        dashboardRepo.saveResult(tileId, hash, { error: outcome.message, durationMs: outcome.durationMs }, now())
      }
    } catch (err) {
      // The tile was removed while its run was in flight.
      logger.debug('a tile result could not be written', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Start (or join) a recompute of `tile` with its current params. */
  function recompute(agent: ComponentAgent, scanned: ScannedComponent, tile: TileDto, options: { skipCommand?: boolean } = {}): Promise<void> {
    const hash = paramsHash(tile.params)
    const memKey = `${tile.id}|${hash}`
    const running = inFlight.get(memKey)
    if (running) return running
    const controller = new AbortController()
    controllers.add(controller)
    const startedEpoch = epoch
    const run = (async () => {
      try {
        const outcome = await runSource(agent, scanned, effectiveParams(tile, scanned), tile.id, controller.signal, options)
        // Skipped, replaced or cancelled: the tile keeps what it has, with no error.
        if (!outcome.ok && (outcome.code === 'busy' || outcome.code === 'superseded' || outcome.code === 'cancelled' || outcome.code === 'interrupted')) return
        if (startedEpoch !== epoch) return
        record(tile.id, hash, outcome)
      } catch (err) {
        logger.warn('a tile recompute failed', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        controllers.delete(controller)
        inFlight.delete(memKey)
        deps.publish(tile.id)
      }
    })()
    inFlight.set(memKey, run)
    track(run)
    deps.publish(tile.id)
    return run
  }

  /** Whether `reason` asks for a recompute of a tile in this state. */
  function wantsRun(reason: DashboardRefreshReason, tile: TileDto, scanned: ScannedComponent): boolean {
    // Refresh, and a params change, always recompute.
    if (reason === 'manual' || reason === 'params') return true
    const effective = rule(tile, scanned)
    const row = dashboardRepo.result(tile.id, paramsHash(tile.params))
    const hasData = !!row && row.fetchedAt !== null
    // Manual: nothing runs on its own once the tile has data.
    if (effective.manual && hasData) return false
    const spec = scanned.spec
    if (reason === 'after_turn') {
      // A plain file re-read costs nothing; a script runs only when asked for.
      if (spec && 'file' in spec.source && !spec.refreshCommand) return true
      return effective.afterTurn
    }
    // The schedule wrote what the source reads.
    if (reason === 'schedule') return effective.schedule !== null
    if (reason === 'launch') return effective.onAppStart && (!row || row.fetchedAt === null || now() - row.fetchedAt > effective.maxAgeMs)
    if (reason === 'interval') {
      if (effective.whileOpenEveryMs === null) return false
      // A visible or after-turn run moments ago counts: at most one run per half period.
      return !row || now() - row.updatedAt >= effective.whileOpenEveryMs / 2
    }
    if (!row || (row.fetchedAt === null && row.error === null)) return true
    // The last attempt, good or failed: a failing script is retried once per max age, not per renewal.
    return now() - row.updatedAt > effective.maxAgeMs
  }

  /**
   * Whether `targetKey` has room for one more endpoint run in the sliding
   * minute. One budget per target: a page's `tools/call`s, its tile's params
   * changes and a preview's params runs all count against it.
   */
  function underCallLimit(targetKey: string): boolean {
    const at = now()
    const recent = (callTimes.get(targetKey) ?? []).filter((t) => at - t < CALL_RATE_WINDOW_MS)
    callTimes.set(targetKey, recent)
    return recent.length < DASHBOARD_CALLS_PER_MINUTE
  }

  function countCall(targetKey: string): void {
    const recent = callTimes.get(targetKey) ?? []
    recent.push(now())
    callTimes.set(targetKey, recent)
  }

  /** One target's endpoint runs in the last minute, this one counted if it is let through. */
  function admitCall(targetKey: string): boolean {
    if (!underCallLimit(targetKey)) return false
    countCall(targetKey)
    return true
  }

  const service = {
    /** A tile's cached data and state; runs nothing. */
    tileResult(userId: string, tileId: unknown): DashboardsOutcome<{ result: TileResultDto }> {
      const resolved = deps.dashboards.resolveTile(userId, tileId)
      if (!resolved) return { ok: false, code: 'not_found', message: 'That tile is gone.' }
      return { ok: true, result: resultFor(resolved.tile, resolved.scanned) }
    },

    /**
     * Recompute `tileId` if `reason` and its state call for it; answers with
     * the state at once (`refreshing` set when a run started or was joined).
     * `wait` resolves only after the run, for tests and callers that need it.
     */
    async ensureFresh(userId: string, tileId: unknown, reason: unknown, options: { wait?: boolean; syncTimer?: boolean } = {}): Promise<DashboardsOutcome<{ result: TileResultDto }>> {
      if (!(REFRESH_REASONS as readonly unknown[]).includes(reason)) return { ok: false, code: 'invalid_input', message: 'Unknown refresh reason.' }
      const why = reason as DashboardRefreshReason
      const resolved = deps.dashboards.resolveTile(userId, tileId)
      if (!resolved) return { ok: false, code: 'not_found', message: 'That tile is gone.' }
      const { agent, scanned, tile } = resolved
      // A renewal starts, re-times or stops the tile's interval.
      if (options.syncTimer) syncTimer(userId, tile, resolved.view.state === 'ok' ? scanned : null)
      if (resolved.view.state !== 'ok' || !agent || !scanned?.spec) return { ok: true, result: resultFor(tile, scanned) }
      // Nothing is spawned without the credentials it needs; the cached data stays beside the sentence.
      const missing = scanned.info.missingCredentials
      if (missing.length > 0) return { ok: true, result: { ...resultFor(tile, scanned), error: missingCredentialsMessage(missing) } }
      if (wantsRun(why, tile, scanned)) {
        // A schedule-fed tile re-reads what its schedule wrote; Refresh does the same.
        const scheduleFed = scanned.spec.schedule !== null && (why === 'schedule' || why === 'manual')
        const run = recompute(agent, scanned, tile, { skipCommand: scheduleFed })
        if (options.wait) await run
      }
      return { ok: true, result: resultFor(tile, scanned) }
    },

    /**
     * A tile's params from a native filter or `cinna.setParams`: validated and
     * kept on the tile (`dashboardService.setParams`), then recomputed with
     * reason `params`; the change is published either way. Counts against
     * the tile's `DASHBOARD_CALLS_PER_MINUTE` budget (a page calling
     * `cinna.setParams` in a loop recomputes each time); above it nothing is
     * kept or run. A refused value costs nothing.
     */
    async setParams(userId: string, input: unknown, options: { wait?: boolean } = {}): Promise<DashboardsOutcome<{ tile: TileDto }>> {
      const tileId = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).tileId : undefined
      const resolved = deps.dashboards.resolveTile(userId, tileId)
      if (!resolved) return { ok: false, code: 'not_found', message: 'That tile is gone.' }
      const targetKey = `tile:${resolved.tile.id}`
      if (!underCallLimit(targetKey)) return { ok: false, code: 'rate_limited', message: rateLimitedMessage('tile') }
      const saved = deps.dashboards.setParams(userId, input)
      if (!saved.ok) return saved
      countCall(targetKey)
      deps.publish(saved.tile.id)
      await service.ensureFresh(userId, saved.tile.id, 'params', options)
      return saved
    },

    /**
     * Whole seconds until the tile's budget lets one more run through (at
     * least 1): the `retry_after_s` of an agent's `rate_limited`.
     */
    retryAfterSeconds(tileId: string): number {
      const at = now()
      const recent = (callTimes.get(`tile:${tileId}`) ?? []).filter((t) => at - t < CALL_RATE_WINDOW_MS)
      if (recent.length < DASHBOARD_CALLS_PER_MINUTE) return 1
      const freeAt = recent[recent.length - DASHBOARD_CALLS_PER_MINUTE] + CALL_RATE_WINDOW_MS
      return Math.max(1, Math.ceil((freeAt - at) / 1000))
    },

    /**
     * `tools/call` from a component's page (README §5.4): one of the
     * component's own endpoints, run once and never cached. The target is a
     * tile of this profile or a preview's component; every refusal and failure
     * is data, with a sentence the page shows.
     */
    async call(userId: string, input: unknown): Promise<DashboardCallOutcome> {
      const value = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
      const target = value.target && typeof value.target === 'object' && !Array.isArray(value.target) ? (value.target as Record<string, unknown>) : null
      if (!target) return { ok: false, code: 'invalid_input', message: 'No tile or component named.' }
      let agent: ComponentAgent
      let scanned: ScannedComponent
      let tileParams: Record<string, unknown> = {}
      let targetKey: string
      if (typeof target.tileId === 'string') {
        const resolved = deps.dashboards.resolveTile(userId, target.tileId)
        if (!resolved) return { ok: false, code: 'not_found', message: 'That tile is gone.' }
        if (!resolved.agent || !resolved.scanned) return { ok: false, code: 'not_found', message: 'That component is no longer in the agent’s folder.' }
        agent = resolved.agent
        scanned = resolved.scanned
        tileParams = resolved.tile.params
        targetKey = `tile:${resolved.tile.id}`
      } else {
        const found = deps.dashboards.resolveComponent(target.agentId, target.component, target.skill)
        if (!found) return { ok: false, code: 'not_found', message: 'That component is no longer in the agent’s folder.' }
        agent = found.agent
        scanned = found.scanned
        targetKey = `preview:${userId}:${agent.id}:${scanned.info.skill ?? ''}:${scanned.info.name}`
      }
      const spec = scanned.spec
      if (!spec) return { ok: false, code: 'component_invalid', message: 'This component has problems to fix before it can run.' }
      const endpoint = value.endpoint
      if (typeof endpoint !== 'string' || !Object.prototype.hasOwnProperty.call(spec.endpoints, endpoint)) {
        return { ok: false, code: 'invalid_input', message: `“${String(endpoint).slice(0, 64)}” is not one of this component’s endpoints.` }
      }
      const checked = checkCallParams(value.params, spec.params)
      if (!checked.ok) return { ok: false, code: 'invalid_input', message: checked.message }
      // Nothing is spawned without the credentials it needs.
      if (scanned.info.missingCredentials.length > 0) return { ok: false, code: 'needs_credentials', message: missingCredentialsMessage(scanned.info.missingCredentials) }
      if (!admitCall(targetKey)) {
        return { ok: false, code: 'rate_limited', message: `This page called its endpoints more than ${DASHBOARD_CALLS_PER_MINUTE} times in a minute; wait a moment and try again.` }
      }
      // The stdin convention: the tile's values over each param's default, the call's own arguments over both.
      const params = resolveParamWords({ ...tileParams, ...checked.params }, spec.params, new Date(now()))
      const controller = new AbortController()
      controllers.add(controller)
      try {
        const outcome = await track(deps.runner.run(endpointCall(agent, scanned, endpoint, params, `call:${targetKey}:${endpoint}`, controller.signal)))
        if (outcome.ok) return { ok: true, value: outcome.value }
        return { ok: false, code: 'call_failed', message: callFailureMessage(outcome) }
      } finally {
        controllers.delete(controller)
      }
    },

    /**
     * The launch warm-up (README D4): every tile of this profile whose
     * effective `on_app_start` is true recomputes, one at a time, unless its
     * cache is younger than its max age. Off with `CINNA_DASHBOARD_WARMUP=off`;
     * a profile close or quit (`cancelAll`) stops it between tiles and aborts
     * the one running. Resolves when it is done; answers the tile ids it ran.
     */
    async warmUp(userId: string): Promise<string[]> {
      if (deps.warmupDisabled ? deps.warmupDisabled() : process.env.CINNA_DASHBOARD_WARMUP === 'off') return []
      if (!enabled()) return []
      if (warmup) warmup.cancelled = true
      const token = { cancelled: false }
      warmup = token
      const startedEpoch = epoch
      const ran: string[] = []
      try {
        let tileIds: string[] = []
        try {
          for (const dashboard of deps.dashboards.list(userId)) {
            const listed = deps.dashboards.tiles(userId, dashboard.id)
            if (listed.ok) tileIds.push(...listed.tiles.filter((view) => view.state === 'ok').map((view) => view.tile.id))
          }
        } catch (err) {
          logger.warn('could not list the tiles to warm up', { error: err instanceof Error ? err.message : String(err) })
          tileIds = []
        }
        for (const tileId of tileIds) {
          if (token.cancelled || startedEpoch !== epoch || !enabled()) break
          const resolved = deps.dashboards.resolveTile(userId, tileId)
          const { agent, scanned, tile } = resolved ?? {}
          if (!resolved || resolved.view.state !== 'ok' || !agent || !scanned?.spec || !tile) continue
          // Missing credentials: nothing to spawn; the tile says so when it is shown.
          if (scanned.info.missingCredentials.length > 0 || !wantsRun('launch', tile, scanned)) continue
          ran.push(tileId)
          await recompute(agent, scanned, tile)
        }
      } finally {
        if (warmup === token) warmup = null
      }
      return ran
    },

    /**
     * A schedule's run completed (README D4): each tile on this profile's
     * dashboards whose component names it in `refresh.schedule` runs its
     * source once, with reason `schedule`, lease or not. Answers the tile ids asked.
     */
    scheduleRan(userId: string, agentId: string, scheduleName: string): string[] {
      if (!enabled()) return []
      let tileIds: string[] = []
      try {
        tileIds = deps.dashboards.placements(userId, agentId).map((placement) => placement.tileId)
      } catch (err) {
        logger.warn('could not list an agent’s tiles after its schedule ran', { agentId, error: err instanceof Error ? err.message : String(err) })
        return []
      }
      const asked: string[] = []
      for (const tileId of tileIds) {
        const resolved = deps.dashboards.resolveTile(userId, tileId)
        if (resolved?.scanned?.spec?.schedule !== scheduleName) continue
        asked.push(tileId)
        void service.ensureFresh(userId, tileId, 'schedule').catch(() => {})
      }
      return asked
    },

    /**
     * A component's data for a preview (the agent tab, the Add dialog): run
     * once, never cached. Nothing runs unless the user asked for the preview.
     * `params`, when given (a preview's filters or its page's `setParams`),
     * are checked as a tile's are and the source runs with them, counted
     * against the preview target's `DASHBOARD_CALLS_PER_MINUTE` budget (the
     * same one its page's `tools/call`s use); a preview without params is the
     * user's own click and is not counted.
     */
    async preview(userId: string, agentId: unknown, component: unknown, skill?: unknown, params?: unknown): Promise<DashboardsOutcome<{ result: TileResultDto }>> {
      const found = deps.dashboards.resolveComponent(agentId, component, skill)
      if (!found) return { ok: false, code: 'not_found', message: 'That component is no longer in the agent’s folder.' }
      if (!found.scanned.spec) return { ok: false, code: 'component_invalid', message: 'This component has problems to fix before it can run.' }
      let previewParams: Record<string, unknown> = {}
      if (params !== undefined && params !== null) {
        const checked = normalizeTileParams(params, found.scanned.spec.params)
        if (!checked.ok) return { ok: false, code: 'invalid_input', message: checked.message }
        previewParams = checked.params
      }
      const missing = found.scanned.info.missingCredentials
      if (missing.length > 0) {
        const result: TileResultDto = { tileId: '', data: null, fetchedAt: null, error: missingCredentialsMessage(missing), refreshing: false, stale: false, tooLarge: false, notice: null }
        return { ok: true, result }
      }
      const targetKey = `preview:${userId}:${found.agent.id}:${found.scanned.info.skill ?? ''}:${found.scanned.info.name}`
      // Only a page's own params count: opening a preview sends `{}` and is never refused.
      if (Object.keys(previewParams).length > 0 && !admitCall(targetKey)) return { ok: false, code: 'rate_limited', message: rateLimitedMessage('preview') }
      const controller = new AbortController()
      controllers.add(controller)
      try {
        const tile: TileDto = { id: '', dashboardId: '', agentManifestId: found.agent.manifestId, component: found.scanned.info.name, skill: found.scanned.info.skill, title: null, size: found.scanned.spec.size, position: 0, params: previewParams, refreshOverride: null }
        const outcome = await track(runSource(found.agent, found.scanned, effectiveParams(tile, found.scanned), targetKey, controller.signal))
        const at = now()
        const data = outcome.ok ? outcome.value : null
        return {
          ok: true,
          result: {
            tileId: '',
            data,
            fetchedAt: outcome.ok ? at : null,
            error: outcome.ok ? null : outcome.code === 'superseded' ? null : outcome.message,
            refreshing: false,
            stale: false,
            tooLarge: false,
            notice: notice(data)
          }
        }
      } finally {
        controllers.delete(controller)
      }
    },

    /**
     * The renderer's "these tiles are on screen", renewed every 20 s. Each
     * leased tile is re-checked, so one that went stale while shown recomputes.
     */
    renewLease(userId: string, tileIds: unknown): DashboardsOutcome<object> {
      if (!Array.isArray(tileIds) || !tileIds.every((id) => typeof id === 'string')) return { ok: false, code: 'invalid_input', message: 'No tiles named.' }
      const expiresAt = now() + DASHBOARD_LEASE_TTL_MS
      // Deduped and capped: a renderer cannot make one renewal start unbounded work.
      for (const tileId of [...new Set(tileIds as string[])].slice(0, MAX_LEASED_TILES)) {
        leases.set(tileId, { userId, expiresAt })
        void service.ensureFresh(userId, tileId, 'visible', { syncTimer: true }).catch(() => {})
      }
      return { ok: true }
    },

    /** The window was hidden or lost focus, or the dashboard closed: no tile of it is on screen. */
    dropLease(userId: string, tileIds?: unknown): DashboardsOutcome<object> {
      const ids = Array.isArray(tileIds) ? tileIds.filter((id): id is string => typeof id === 'string') : null
      for (const [tileId, lease] of leases) {
        if (lease.userId === userId && (!ids || ids.includes(tileId))) {
          leases.delete(tileId)
          stopTimer(tileId)
        }
      }
      return { ok: true }
    },

    /**
     * A turn of `agentId` (a row id) ended: each of its tiles on this
     * profile's dashboards that is on screen by a live lease is asked again
     * with `after_turn`. Answers the tile ids asked.
     */
    afterTurn(userId: string, agentId: string): string[] {
      let tileIds: string[] = []
      try {
        tileIds = deps.dashboards.placements(userId, agentId).map((placement) => placement.tileId)
      } catch (err) {
        logger.warn('could not list an agent’s tiles after its turn', { agentId, error: err instanceof Error ? err.message : String(err) })
        return []
      }
      const asked = tileIds.filter((tileId) => service.isLeased(tileId, userId))
      for (const tileId of asked) void service.ensureFresh(userId, tileId, 'after_turn').catch(() => {})
      return asked
    },

    /** Whether a tile is on screen by a live lease (the profile's, when `userId` is given). */
    isLeased(tileId: string, userId?: string): boolean {
      const lease = leases.get(tileId)
      if (!lease || (userId !== undefined && lease.userId !== userId)) return false
      if (lease.expiresAt <= now()) {
        leases.delete(tileId)
        stopTimer(tileId)
        return false
      }
      return true
    },

    /**
     * The profile is being left, or the app quits: stop every run (each
     * endpoint's process group is killed as the abort lands), forget every
     * lease and in-memory result. Resolves once every run has ended, for a
     * host that awaits process exit.
     */
    cancelAll(): Promise<void> {
      epoch++
      if (warmup) warmup.cancelled = true
      warmup = null
      for (const controller of controllers) controller.abort()
      controllers.clear()
      for (const tileId of [...timers.keys()]) stopTimer(tileId)
      leases.clear()
      uncached.clear()
      callTimes.clear()
      return Promise.allSettled([...pending]).then(() => undefined)
    },

    /** For tests: runs in flight now. */
    inFlightCount(): number {
      return inFlight.size
    },

    /** For tests: tiles with an interval timer now. */
    timerCount(): number {
      return timers.size
    }
  }
  return service
}

export type DashboardRefreshService = ReturnType<typeof createDashboardRefreshService>

export const dashboardRefreshService = createDashboardRefreshService({
  dashboards: dashboardService,
  runner: endpointRunner,
  runCommand: (agentId, name, signal) =>
    commandService.run(getSettingsScopeUserId(), agentId, name, signal, undefined, { yieldingOwner: DASHBOARD_LOCK_OWNER }),
  publish: (tileId) => publishEvent(DASHBOARDS_TILE_CHANGED_CHANNEL, { tileId }),
  enabled: () => capabilityService.isOn('dashboards')
})
