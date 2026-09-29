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
 *   against it after a restart. It is a reading, not an addition.
 */

import {
  EMPTY_TOKEN_TALLY,
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
      }
      return next
    }
    case 'context': {
      // A size proven for another session or another model proves nothing
      // about this one.
      const model = base.model.selected
      const sameContext = base.context.sessionId === change.sessionId && base.context.model === model
      next.context = {
        ...base.context,
        used: change.used ?? base.context.used,
        size: change.size ?? base.context.size,
        // Claude's size is a guess until a result corrects it, which is the
        // costed reading; Codex reports the model's window from the start.
        sizeAuthoritative: (sameContext && base.context.sizeAuthoritative) || change.costed || change.engine === 'codex',
        sessionId: change.sessionId
      }
      if (model !== undefined) next.context.model = model
      else delete next.context.model
      next.cache = { ...base.cache, lastRequestAt: change.at }
      if (change.rateLimit !== undefined) next.rateLimit = change.rateLimit
      if (change.costReading !== undefined) {
        const session = base.totals.bySession[change.sessionId] ?? { tokens: { ...EMPTY_TOKEN_TALLY }, turns: 0 }
        next.totals = {
          ...base.totals,
          bySession: { ...base.totals.bySession, [change.sessionId]: { ...session, lastCostReading: change.costReading } }
        }
      }
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
      const priorSession: SessionTelemetrySessionTotals = base.totals.bySession[change.sessionId] ?? { tokens: { ...EMPTY_TOKEN_TALLY }, turns: 0 }
      const sessionCost = addCost(priorSession.costUsd, message.costUsd)
      const totalCost = addCost(base.totals.costUsd, message.costUsd)
      next.totals = {
        ...base.totals,
        tokens: add(base.totals.tokens, message.tokens),
        ...(totalCost !== undefined ? { costUsd: totalCost } : {}),
        turns: base.totals.turns + 1,
        tokenScope: base.totals.tokenScope === 'last_request' || message.tokenScope === 'last_request' ? 'last_request' : base.totals.tokenScope,
        byModel,
        bySession: {
          ...base.totals.bySession,
          [change.sessionId]: {
            tokens: add(priorSession.tokens, message.tokens),
            ...(sessionCost !== undefined ? { costUsd: sessionCost } : {}),
            turns: priorSession.turns + 1,
            ...(priorSession.lastCostReading !== undefined ? { lastCostReading: priorSession.lastCostReading } : {})
          }
        }
      }
      const selected = change.selectedModel ?? base.model.selected
      next.model = message.model
        ? { ...(selected ? { selected } : {}), resolved: message.model, source: 'quota' }
        : { ...base.model, ...(selected ? { selected } : {}) }
      return next
    }
  }
}
