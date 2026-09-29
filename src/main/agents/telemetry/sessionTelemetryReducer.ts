/**
 * The one reducer behind session telemetry: a chat's state plus one change
 * from its runtime gives the next state. Pure — no clock, no I/O; the caller
 * passes `now`.
 *
 * Rules:
 *
 * - **Totals are the chat's**, over every ACP session it had, and come only
 *   from `turn` changes — one per finished turn. A `context` reading never
 *   adds to them, so a reading seen twice cannot count twice.
 * - **Subagents count in the totals, not in the context or the model.** A
 *   turn's `byModel` rows (subagents' models included) feed `byModel`; the
 *   resolved model is the turn's main model only, and `context` is set only
 *   from the main session's readings.
 * - A turn whose tokens cover only its last request (`codex-acp`) marks the
 *   totals `last_request`: they are a lower bound from then on.
 * - A costed `context` reading records the session's running cost total
 *   (`bySession[id].lastCostReading`); the driver measures the next reading
 *   against it after a restart. It is a reading, not an addition. So are a
 *   turn's per-model readings (`modelCostReadings`).
 * - **The cache clock is Claude's.** A main-agent `request` sets
 *   `lastRequestAt`, the TTL its writes show (1h over 5m, else the last one
 *   seen, else an assumed 5m) and `expiresAt`. A model switch, a new session,
 *   a session reloaded under other params and a compaction mark it cold
 *   (`invalidatedAt`); only a new session and a compaction also reset the
 *   context baseline. Codex gets no TTL, no
 *   expiry and no invalidation: its cache TTL is not reported.
 */

import {
  CACHE_TTL_KNOWN,
  EMPTY_TOKEN_TALLY,
  type CacheInvalidationReason,
  type SessionTelemetry,
  type SessionTelemetryChange,
  type SessionTelemetrySessionTotals,
  type TelemetryEngine,
  type TokenTally
} from '../../../shared/sessionTelemetry'

export function emptySessionTelemetry(chatId: string, engine: TelemetryEngine, now: number): SessionTelemetry {
  return {
    chatId,
    engine,
    auth: { kind: 'unknown' },
    model: { source: 'config' },
    context: { used: 0, size: 0, sizeAuthoritative: false },
    totals: {
      tokens: { ...EMPTY_TOKEN_TALLY },
      costSource: 'runtime',
      turns: 0,
      tokenScope: 'turn',
      byModel: {},
      bySession: {}
    },
    cache: { ttlSource: 'assumed' },
    updatedAt: now
  }
}

function add(a: TokenTally, b: TokenTally): TokenTally {
  const sum: TokenTally = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  }
  if (a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined) sum.cacheWrite1h = (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0)
  return sum
}

export const CACHE_TTL_5M_MS = 5 * 60_000
export const CACHE_TTL_1H_MS = 60 * 60_000

/**
 * The cache went cold (Claude only). Only a new session and a compaction also
 * start the context baseline over: after a model switch or a reload under
 * other params the conversation is the same one, so its split stands.
 */
function invalidate(next: SessionTelemetry, reason: CacheInvalidationReason, at: number): void {
  if (!CACHE_TTL_KNOWN[next.engine]) return
  next.cache = { ...next.cache, invalidatedAt: at, invalidationReason: reason }
  if (reason !== 'new_session' && reason !== 'compaction') return
  const context = { ...next.context, awaitingBaseline: true }
  delete context.breakdown
  next.context = context
}

function sessionTotals(state: SessionTelemetry, sessionId: string): SessionTelemetrySessionTotals {
  return state.totals.bySession[sessionId] ?? { tokens: { ...EMPTY_TOKEN_TALLY }, turns: 0 }
}

function withSession(state: SessionTelemetry, sessionId: string, patch: Partial<SessionTelemetrySessionTotals>): SessionTelemetry['totals'] {
  return {
    ...state.totals,
    bySession: { ...state.totals.bySession, [sessionId]: { ...sessionTotals(state, sessionId), ...patch } }
  }
}

function addCost(a: number | undefined, b: number | undefined): number | undefined {
  return b === undefined ? a : (a ?? 0) + b
}

export function applyTelemetryChange(
  state: SessionTelemetry | null,
  chatId: string,
  change: SessionTelemetryChange,
  now: number
): SessionTelemetry {
  const base = state ?? emptySessionTelemetry(chatId, change.engine, now)
  const next: SessionTelemetry = { ...base, engine: change.engine, updatedAt: now }
  switch (change.type) {
    case 'auth':
      next.auth = { ...change.auth }
      return next
    case 'model': {
      if (change.selected === base.model.selected) return next
      // The first report names what is selected; a later different one is a
      // switch, and what answered before is not what answers now.
      if (base.model.selected === undefined) {
        next.model = { ...base.model, selected: change.selected }
      } else {
        next.model = { selected: change.selected, source: 'config' }
        // Another model, another window: the size stands as a guess until
        // a reading under the new model corrects it.
        next.context = { ...base.context, sizeAuthoritative: false }
        // And another cache: nothing the old model wrote is read by the new one.
        invalidate(next, 'model_change', now)
      }
      return next
    }
    case 'context': {
      // A size proven for another session or another model proves nothing
      // about this one.
      const model = base.model.selected
      const sameContext = base.context.sessionId === change.sessionId && base.context.model === model
      const used = change.used ?? base.context.used
      next.context = {
        ...base.context,
        used,
        size: change.size ?? base.context.size,
        // Claude's size is a guess until a result corrects it, which is the
        // costed reading; Codex reports the model's window from the start.
        sizeAuthoritative: (sameContext && base.context.sizeAuthoritative) || change.costed || change.engine === 'codex',
        sessionId: change.sessionId
      }
      if (model !== undefined) next.context.model = model
      else delete next.context.model
      if (base.context.breakdown) {
        next.context.breakdown = { baseline: base.context.breakdown.baseline, conversation: Math.max(0, used - base.context.breakdown.baseline) }
      }
      // Without the raw stream, the last reading is the best clock there is.
      if (!change.cacheTimed) {
        next.cache = { ...base.cache, lastRequestAt: change.at }
        if (CACHE_TTL_KNOWN[change.engine]) {
          const ttlMs = base.cache.ttlMs ?? CACHE_TTL_5M_MS
          next.cache.ttlMs = ttlMs
          next.cache.expiresAt = change.at + ttlMs
        }
      }
      if (change.rateLimit !== undefined) next.rateLimit = change.rateLimit
      if (change.costReading !== undefined) {
        next.totals = withSession(base, change.sessionId, { lastCostReading: change.costReading })
      }
      return next
    }
    case 'runtime': {
      const runtime = { ...(base.runtime ?? {}) }
      if (change.cliVersion !== undefined) runtime.cliVersion = change.cliVersion
      if (change.betas !== undefined) runtime.betas = [...change.betas]
      if (change.effort !== undefined) runtime.effort = change.effort
      if (change.fastMode !== undefined) runtime.fastMode = change.fastMode
      next.runtime = runtime
      if (change.model) next.model = { ...base.model, resolved: change.model, source: 'init' }
      // A hint refines a login nobody reported; it never overrides one.
      if (change.authHint && base.auth.kind === 'unknown') next.auth = { kind: change.authHint }
      return next
    }
    case 'request': {
      if (change.model) next.model = { ...base.model, resolved: change.model, source: 'init' }
      if (!CACHE_TTL_KNOWN[change.engine]) return next
      // The TTL the writes used: 1h over 5m; a request that wrote nothing
      // keeps what was last seen; never seen, 5m is assumed.
      let ttlMs = base.cache.ttlMs
      let ttlSource = base.cache.ttlSource
      if (change.cacheWrite1h > 0) {
        ttlMs = CACHE_TTL_1H_MS
        ttlSource = 'observed'
      } else if (change.cacheWrite5m > 0) {
        ttlMs = CACHE_TTL_5M_MS
        ttlSource = 'observed'
      } else if (ttlMs === undefined) {
        ttlMs = CACHE_TTL_5M_MS
        ttlSource = 'assumed'
      }
      next.cache = { ...base.cache, lastRequestAt: change.at, ttlMs, ttlSource, expiresAt: change.at + ttlMs }
      if (base.context.awaitingBaseline && change.input > 0) {
        // The request's own input is the whole context at that point; the
        // next reading adds the conversation on top.
        const context = { ...base.context, breakdown: { baseline: change.input, conversation: 0 } }
        delete context.awaitingBaseline
        next.context = context
      }
      return next
    }
    case 'compaction':
      invalidate(next, 'compaction', change.at)
      return next
    case 'session': {
      const prior = base.totals.bySession[change.sessionId]?.fingerprint
      if (change.fresh) invalidate(next, 'new_session', change.at)
      // Reloaded under other params (cwd, MCP servers): the adapter rebuilt
      // it, with another system prompt and tool list.
      else if (prior !== undefined && prior !== change.fingerprint) invalidate(next, 'session_params_change', change.at)
      if (prior !== change.fingerprint) next.totals = withSession(base, change.sessionId, { fingerprint: change.fingerprint })
      return next
    }
    case 'turn': {
      const message = change.message
      const byModel = { ...base.totals.byModel }
      const rows = change.byModel ?? (message.model && message.tokenScope !== 'none' ? { [message.model]: message.tokens } : {})
      for (const [model, tally] of Object.entries(rows)) {
        const prior = byModel[model]
        byModel[model] = prior ? { ...add(prior, tally), ...(prior.costUsd !== undefined ? { costUsd: prior.costUsd } : {}) } : { ...tally }
      }
      for (const [model, cost] of Object.entries(change.byModelCost ?? {})) {
        const prior = byModel[model] ?? { ...EMPTY_TOKEN_TALLY }
        byModel[model] = { ...prior, costUsd: (prior.costUsd ?? 0) + cost }
      }
      const priorSession = sessionTotals(base, change.sessionId)
      const sessionCost = addCost(priorSession.costUsd, message.costUsd)
      const totalCost = addCost(base.totals.costUsd, message.costUsd)
      const estimated = message.costUsd !== undefined && message.costSource === 'estimated'
      next.totals = {
        ...base.totals,
        tokens: add(base.totals.tokens, message.tokens),
        ...(totalCost !== undefined ? { costUsd: totalCost } : {}),
        costSource: estimated ? 'estimated' : base.totals.costSource,
        turns: base.totals.turns + 1,
        tokenScope: base.totals.tokenScope === 'last_request' || message.tokenScope === 'last_request' ? 'last_request' : base.totals.tokenScope,
        byModel,
        ...(message.tokenScope !== 'none' ? { lastTurn: { ...message.tokens } } : {}),
        bySession: {
          ...base.totals.bySession,
          [change.sessionId]: {
            ...priorSession,
            tokens: add(priorSession.tokens, message.tokens),
            ...(sessionCost !== undefined ? { costUsd: sessionCost } : {}),
            turns: priorSession.turns + 1,
            ...(change.modelCostReadings ? { modelCostReadings: { ...(priorSession.modelCostReadings ?? {}), ...change.modelCostReadings } } : {})
          }
        }
      }
      const selected = change.selectedModel ?? base.model.selected
      next.model = message.model
        ? { ...(selected ? { selected } : {}), resolved: message.model, source: 'quota' }
        : { ...base.model, ...(selected ? { selected } : {}) }
      if (change.contextWindow !== undefined && change.contextWindow > 0) {
        next.context = { ...base.context, size: change.contextWindow, sizeAuthoritative: true }
      }
      if (change.maxOutputTokens !== undefined && change.maxOutputTokens > 0) {
        next.context = { ...next.context, maxOutput: change.maxOutputTokens }
      }
      return next
    }
  }
}
