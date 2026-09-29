import { describe, expect, it } from 'vitest'
import type { ContextCategories, MessageTelemetry, SessionTelemetry, SessionTelemetryChange, TokenTally } from '../../../shared/sessionTelemetry'
import { applyTelemetryChange } from './sessionTelemetryReducer'

const tally = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenTally => ({ input, output, cacheRead, cacheWrite })

const turn = (message: Partial<MessageTelemetry> & { tokens: TokenTally }, extra: Partial<Extract<SessionTelemetryChange, { type: 'turn' }>> = {}): SessionTelemetryChange => ({
  type: 'turn',
  engine: 'claude',
  sessionId: 's1',
  message: { tokenScope: 'turn', costSource: 'runtime', ...message },
  ...extra
})

const context = (used: number, size: number, costed = false, at = 1): SessionTelemetryChange =>
  ({ type: 'context', engine: 'claude', sessionId: 's1', used, size, costed, at })

function fold(changes: SessionTelemetryChange[]): SessionTelemetry {
  let state: SessionTelemetry | null = null
  let now = 0
  for (const change of changes) state = applyTelemetryChange(state, 'chat', change, ++now)
  return state!
}

describe('the session telemetry reducer', () => {
  it('adds turns into the chat’s totals, per model and per session', () => {
    const state = fold([
      turn({ model: 'claude-sonnet-5[1m]', tokens: tally(10, 200, 30_000, 1_500), costUsd: 0.04 }, {
        byModel: { 'claude-sonnet-5[1m]': tally(10, 200, 30_000, 1_500) }
      }),
      turn({ model: 'claude-sonnet-5[1m]', tokens: tally(5, 100, 31_000, 0), costUsd: 0.01 }, { sessionId: 's2' })
    ])
    expect(state.totals).toMatchObject({
      tokens: tally(15, 300, 61_000, 1_500),
      turns: 2,
      tokenScope: 'turn',
      byModel: { 'claude-sonnet-5[1m]': tally(15, 300, 61_000, 1_500) },
      bySession: { s1: { tokens: tally(10, 200, 30_000, 1_500), costUsd: 0.04, turns: 1 }, s2: { turns: 1, costUsd: 0.01 } }
    })
    expect(state.totals.costUsd).toBeCloseTo(0.05)
    expect(state.model).toEqual({ resolved: 'claude-sonnet-5[1m]', source: 'quota' })
  })

  it('counts subagents in the totals without letting them name the model or the context', () => {
    const state = fold([
      context(16_000, 1_000_000, true),
      turn({ model: 'claude-sonnet-5[1m]', tokens: tally(15, 320, 38_000, 2_400), contextUsedAfter: 16_000 }, {
        byModel: { 'claude-sonnet-5[1m]': tally(10, 200, 30_000, 1_500), 'claude-haiku-4-5': tally(5, 120, 8_000, 900) }
      })
    ])
    expect(state.model.resolved).toBe('claude-sonnet-5[1m]')
    expect(state.context).toEqual({ used: 16_000, size: 1_000_000, sizeAuthoritative: true, sessionId: 's1' })
    expect(state.totals.byModel['claude-haiku-4-5']).toEqual(tally(5, 120, 8_000, 900))
    expect(state.totals.tokens).toEqual(tally(15, 320, 38_000, 2_400))
  })

  it('never adds a context reading to the totals, so one seen twice counts nothing twice', () => {
    const once = fold([context(100, 200_000), turn({ tokens: tally(1, 2), costUsd: 0.1 })])
    const replayed = fold([context(100, 200_000), context(100, 200_000, true), context(100, 200_000, true), turn({ tokens: tally(1, 2), costUsd: 0.1 })])
    expect(replayed.totals).toEqual(once.totals)
  })

  it('counts a follow-up turn once, from its cost alone', () => {
    const state = fold([
      turn({ tokens: tally(1, 2), costUsd: 0.1 }),
      turn({ tokens: tally(0, 0), tokenScope: 'none', costUsd: 0.0407752 })
    ])
    expect(state.totals.turns).toBe(2)
    expect(state.totals.tokens).toEqual(tally(1, 2))
    expect(state.totals.costUsd).toBeCloseTo(0.1407752)
    expect(state.totals.tokenScope).toBe('turn')
    expect(state.totals.byModel).toEqual({})
  })

  it('marks the totals a lower bound once a turn covered only its last request', () => {
    const state = fold([
      turn({ tokens: tally(1, 2) }),
      { ...turn({ model: 'gpt-5.5-codex', tokens: tally(1_000, 345, 11_000), tokenScope: 'last_request' }), engine: 'codex' },
      turn({ tokens: tally(1, 2) })
    ])
    expect(state.totals.tokenScope).toBe('last_request')
    expect(state.totals.costUsd).toBeUndefined()
  })

  it('takes the context from every reading, and trusts the size after a costed one or on Codex', () => {
    const claude = fold([context(10, 200_000), context(20, 200_000)])
    expect(claude.context).toEqual({ used: 20, size: 200_000, sizeAuthoritative: false, sessionId: 's1' })
    expect(claude.cache.lastRequestAt).toBe(1)
    expect(fold([context(10, 200_000), context(30, 1_000_000, true), context(40, 1_000_000)]).context.sizeAuthoritative).toBe(true)
    expect(fold([{ type: 'context', engine: 'codex', sessionId: 's', used: 5, size: 258_400, costed: false, at: 1 }]).context.sizeAuthoritative).toBe(true)
  })

  it('treats the size as a guess again when the context’s session or model changes', () => {
    const proven = fold([{ type: 'model', engine: 'claude', selected: 'default' }, context(30, 1_000_000, true)])
    expect(proven.context).toMatchObject({ sizeAuthoritative: true, sessionId: 's1', model: 'default' })
    // Another session: its first uncosted reading is the adapter's guess.
    const otherSession = applyTelemetryChange(proven, 'chat', { type: 'context', engine: 'claude', sessionId: 's2', used: 5, size: 200_000, costed: false, at: 9 }, 9)
    expect(otherSession.context).toMatchObject({ sizeAuthoritative: false, sessionId: 's2' })
    // Another model: a guess from the switch on, and still one for its first uncosted reading.
    const switched = applyTelemetryChange(proven, 'chat', { type: 'model', engine: 'claude', selected: 'opus' }, 9)
    expect(switched.context.sizeAuthoritative).toBe(false)
    const read = applyTelemetryChange({ ...switched, context: { ...switched.context, sizeAuthoritative: true } }, 'chat', context(40, 200_000), 10)
    expect(read.context).toMatchObject({ sizeAuthoritative: false, model: 'opus' })
    // The same session and model keep it.
    expect(applyTelemetryChange(proven, 'chat', context(50, 1_000_000), 9).context.sizeAuthoritative).toBe(true)
  })

  it('keeps the session’s last cost reading, without adding it to the totals', () => {
    const state = fold([
      { type: 'context', engine: 'claude', sessionId: 's1', used: 1, size: 2, costed: true, costReading: 1.25, at: 1 },
      turn({ tokens: tally(1, 2), costUsd: 0.25 }),
      { type: 'context', engine: 'claude', sessionId: 's1', used: 1, size: 2, costed: false, at: 2 }
    ])
    expect(state.totals.bySession.s1).toMatchObject({ lastCostReading: 1.25, turns: 1, costUsd: 0.25 })
    expect(state.totals.costUsd).toBe(0.25)
  })

  it('forgets what answered when the selected model changes', () => {
    const state = fold([
      { type: 'model', engine: 'claude', selected: 'default' },
      turn({ model: 'claude-sonnet-5[1m]', tokens: tally(1, 1) }, { selectedModel: 'default' }),
      { type: 'model', engine: 'claude', selected: 'default' }
    ])
    expect(state.model).toEqual({ selected: 'default', resolved: 'claude-sonnet-5[1m]', source: 'quota' })
    expect(applyTelemetryChange(state, 'chat', { type: 'model', engine: 'claude', selected: 'opus' }, 9).model)
      .toEqual({ selected: 'opus', source: 'config' })
  })

  it('keeps the latest login, and does not change the state it was given', () => {
    const before = fold([turn({ tokens: tally(1, 1) })])
    const frozen = JSON.stringify(before)
    const after = applyTelemetryChange(before, 'chat', { type: 'auth', engine: 'claude', auth: { kind: 'subscription', label: 'Claude Max', plan: 'max' } }, 9)
    expect(after.auth).toEqual({ kind: 'subscription', label: 'Claude Max', plan: 'max' })
    expect(JSON.stringify(before)).toBe(frozen)
  })
})

const request = (at: number, cache: { write5m?: number; write1h?: number; input?: number; model?: string } = {}): SessionTelemetryChange => ({
  type: 'request',
  engine: 'claude',
  sessionId: 's1',
  ...(cache.model ? { model: cache.model } : {}),
  input: cache.input ?? 50_000,
  cacheWrite5m: cache.write5m ?? 0,
  cacheWrite1h: cache.write1h ?? 0,
  at
})

const MIN = 60_000

describe('the raw stream in the session telemetry', () => {
  it('observes the cache TTL from a request’s writes: 1h over 5m, the last one kept, else 5m assumed', () => {
    const assumed = fold([request(1_000)])
    expect(assumed.cache).toEqual({ lastRequestAt: 1_000, ttlMs: 5 * MIN, ttlSource: 'assumed', expiresAt: 1_000 + 5 * MIN })
    const oneHour = fold([request(1_000, { write5m: 10, write1h: 20 })])
    expect(oneHour.cache).toMatchObject({ ttlMs: 60 * MIN, ttlSource: 'observed', expiresAt: 1_000 + 60 * MIN })
    // A request that wrote nothing keeps what was seen, and moves the clock.
    const kept = fold([request(1_000, { write1h: 20 }), request(2_000)])
    expect(kept.cache).toMatchObject({ ttlMs: 60 * MIN, ttlSource: 'observed', lastRequestAt: 2_000, expiresAt: 2_000 + 60 * MIN })
    expect(fold([request(1_000, { write1h: 20 }), request(2_000, { write5m: 5 })]).cache).toMatchObject({ ttlMs: 5 * MIN, ttlSource: 'observed' })
  })

  it('lets a usage reading move the cache clock only when no raw request timed the turn', () => {
    const untimed = fold([context(10, 200_000, false, 7_000)])
    expect(untimed.cache).toEqual({ lastRequestAt: 7_000, ttlMs: 5 * MIN, ttlSource: 'assumed', expiresAt: 7_000 + 5 * MIN })
    const timed = fold([request(1_000, { write1h: 1 }), { type: 'context', engine: 'claude', sessionId: 's1', used: 10, size: 1, costed: true, at: 9_000, cacheTimed: true }])
    expect(timed.cache).toMatchObject({ lastRequestAt: 1_000, expiresAt: 1_000 + 60 * MIN })
    // Codex: a clock, never a TTL or an expiry.
    const codex = fold([{ type: 'context', engine: 'codex', sessionId: 's', used: 5, size: 258_400, costed: false, at: 3 }])
    expect(codex.cache).toEqual({ lastRequestAt: 3, ttlSource: 'assumed' })
  })

  it('takes the resolved model from the raw stream, and the quota’s once the turn settles', () => {
    const state = fold([
      { type: 'runtime', engine: 'claude', sessionId: 's1', model: 'claude-sonnet-5', cliVersion: '2.1.274', betas: ['b'], effort: null, fastMode: 'off' }
    ])
    expect(state.model).toEqual({ resolved: 'claude-sonnet-5', source: 'init' })
    expect(state.runtime).toEqual({ cliVersion: '2.1.274', betas: ['b'], effort: null, fastMode: 'off' })
    const settled = applyTelemetryChange(applyTelemetryChange(state, 'chat', request(5, { model: 'claude-sonnet-5-20260101' }), 5), 'chat', turn({ model: 'claude-sonnet-5[1m]', tokens: tally(1, 1) }), 6)
    expect(settled.model).toEqual({ resolved: 'claude-sonnet-5[1m]', source: 'quota' })
  })

  it('lets an API key source refine an unknown login, never replace a reported one', () => {
    const hint: SessionTelemetryChange = { type: 'runtime', engine: 'claude', sessionId: 's1', authHint: 'api_key' }
    expect(fold([hint]).auth).toEqual({ kind: 'api_key' })
    expect(fold([{ type: 'auth', engine: 'claude', auth: { kind: 'subscription', plan: 'max' } }, hint]).auth).toEqual({ kind: 'subscription', plan: 'max' })
  })

  it('sets the context baseline from the first main request of a new session, and splits the context from it', () => {
    const state = fold([
      { type: 'session', engine: 'claude', sessionId: 's1', fresh: true, fingerprint: 'fp', at: 1 },
      request(2, { input: 20_000 }),
      request(3, { input: 25_000 }),
      context(26_000, 200_000)
    ])
    expect(state.context.breakdown).toEqual({ baseline: 20_000, conversation: 6_000 })
    expect(state.context.awaitingBaseline).toBeUndefined()
    // Never below zero.
    expect(applyTelemetryChange(state, 'chat', context(1_000, 200_000), 9).context.breakdown).toEqual({ baseline: 20_000, conversation: 0 })
    // No raw stream, no split.
    expect(fold([{ type: 'session', engine: 'claude', sessionId: 's1', fresh: true, fingerprint: 'fp', at: 1 }, context(26_000, 200_000)]).context.breakdown).toBeUndefined()
  })

  it('marks the cache cold on a new session, other params, a model switch and a compaction; resets the baseline only on a new session or a compaction', () => {
    const warm = fold([
      { type: 'model', engine: 'claude', selected: 'default' },
      { type: 'session', engine: 'claude', sessionId: 's1', fresh: false, fingerprint: 'fp1', at: 1 },
      { type: 'session', engine: 'claude', sessionId: 's1', fresh: true, fingerprint: 'fp1', at: 2 },
      request(3, { input: 20_000 })
    ])
    expect(warm.context.breakdown).toBeDefined()
    expect(warm.totals.bySession.s1.fingerprint).toBe('fp1')

    const cases: Array<[SessionTelemetryChange, string]> = [
      [{ type: 'session', engine: 'claude', sessionId: 's2', fresh: true, fingerprint: 'fp1', at: 50 }, 'new_session'],
      [{ type: 'session', engine: 'claude', sessionId: 's1', fresh: false, fingerprint: 'fp2', at: 50 }, 'session_params_change'],
      [{ type: 'model', engine: 'claude', selected: 'opus' }, 'model_change'],
      [{ type: 'compaction', engine: 'claude', sessionId: 's1', at: 50 }, 'compaction']
    ]
    for (const [change, reason] of cases) {
      const cold = applyTelemetryChange(warm, 'chat', change, 50)
      expect(cold.cache).toMatchObject({ invalidatedAt: 50, invalidationReason: reason })
      if (reason === 'new_session' || reason === 'compaction') {
        expect(cold.context.breakdown).toBeUndefined()
        expect(cold.context.awaitingBaseline).toBe(true)
      } else {
        // The same conversation: its split stands.
        expect(cold.context.breakdown).toEqual(warm.context.breakdown)
        expect(cold.context.awaitingBaseline).toBeUndefined()
      }
    }
    // Reloaded under the same params: nothing happened to the cache.
    const same = applyTelemetryChange(warm, 'chat', { type: 'session', engine: 'claude', sessionId: 's1', fresh: false, fingerprint: 'fp1', at: 50 }, 50)
    expect(same.cache).toEqual(warm.cache)
    expect(same.context.breakdown).toEqual(warm.context.breakdown)
    // Codex: no invalidation, only the fingerprint.
    const codex = fold([{ type: 'session', engine: 'codex', sessionId: 's', fresh: true, fingerprint: 'f', at: 1 }])
    expect(codex.cache).toEqual({ ttlSource: 'assumed' })
    expect(codex.totals.bySession.s.fingerprint).toBe('f')
  })

  it('keeps an 80K context’s breakdown through a model switch, with the cache marked cold', () => {
    const warm = fold([
      { type: 'model', engine: 'claude', selected: 'default' },
      { type: 'session', engine: 'claude', sessionId: 's1', fresh: true, fingerprint: 'fp', at: 1 },
      request(2, { input: 20_000 }),
      context(80_000, 200_000, true, 3)
    ])
    expect(warm.context.breakdown).toEqual({ baseline: 20_000, conversation: 60_000 })
    const switched = applyTelemetryChange(warm, 'chat', { type: 'model', engine: 'claude', selected: 'opus' }, 60)
    expect(switched.context.breakdown).toEqual({ baseline: 20_000, conversation: 60_000 })
    expect(switched.context.awaitingBaseline).toBeUndefined()
    expect(switched.cache).toMatchObject({ invalidatedAt: 60, invalidationReason: 'model_change' })
    // The next request under the new model does not re-baseline it.
    expect(applyTelemetryChange(switched, 'chat', request(61, { input: 81_000 }), 61).context.breakdown).toEqual({ baseline: 20_000, conversation: 60_000 })
  })

  it('adds per-model costs, keeps the session’s per-model readings, and takes the main window as authoritative', () => {
    const state = fold([
      context(30_000, 200_000),
      turn({ model: 'claude-sonnet-5[1m]', tokens: tally(1, 2), costUsd: 0.3 }, {
        byModel: { 'claude-sonnet-5[1m]': tally(1, 2) },
        byModelCost: { 'claude-sonnet-5[1m]': 0.25, 'claude-haiku-4-5': 0.05 },
        modelCostReadings: { 'claude-sonnet-5[1m]': 1.25, 'claude-haiku-4-5': 0.05 },
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000
      }),
      turn({ model: 'claude-sonnet-5[1m]', tokens: tally(1, 2), costUsd: 0.1 }, {
        byModelCost: { 'claude-sonnet-5[1m]': 0.1 },
        modelCostReadings: { 'claude-sonnet-5[1m]': 1.35 }
      })
    ])
    expect(state.totals.byModel['claude-sonnet-5[1m]'].costUsd).toBeCloseTo(0.35)
    expect(state.totals.byModel['claude-haiku-4-5']).toEqual({ ...tally(0, 0), costUsd: 0.05 })
    expect(state.totals.bySession.s1.modelCostReadings).toEqual({ 'claude-sonnet-5[1m]': 1.35, 'claude-haiku-4-5': 0.05 })
    expect(state.context).toMatchObject({ size: 1_000_000, sizeAuthoritative: true, maxOutput: 64_000 })
    expect(state.totals.lastTurn).toEqual(tally(1, 2))
    expect(state.totals.costSource).toBe('runtime')
  })

  it('marks the totals estimated once an estimated cost was added', () => {
    const state = fold([
      { ...turn({ model: 'gpt-5.5', tokens: tally(1_000, 10), tokenScope: 'last_request', costUsd: 0.0053, costSource: 'estimated' }), engine: 'codex' }
    ])
    expect(state.totals).toMatchObject({ costUsd: 0.0053, costSource: 'estimated' })
  })
})

describe('context categories and running totals in the session telemetry', () => {
  const categories = (total: number): ContextCategories => ({
    categories: [{ name: 'System prompt', tokens: 3_000 }, { name: 'Messages', tokens: total - 3_000 }],
    totalTokens: total, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: total / 2_000, model: 'claude-sonnet-5',
    memoryFiles: [{ path: '/home/me/project/CLAUDE.md', type: 'Project', tokens: 100 }],
    mcpTools: [], agents: [], systemTools: [], systemPromptSections: []
  })
  const measured = (total: number, at = 50, sessionId = 's1'): SessionTelemetryChange =>
    ({ type: 'context_categories', engine: 'claude', sessionId, categories: categories(total), at })
  const request = (input: number): SessionTelemetryChange =>
    ({ type: 'request', engine: 'claude', sessionId: 's1', input, cacheWrite5m: 0, cacheWrite1h: 0, at: 2 })

  it('keeps a measurement dated and tied to its session, beside the coarse split, and replaces it with the next', () => {
    const state = fold([
      { type: 'session', engine: 'claude', sessionId: 's1', fresh: true, fingerprint: 'f', at: 1 },
      request(12_000), context(14_000, 200_000, true), measured(14_000, 50), measured(15_000, 60)
    ])
    expect(state.context.breakdown).toEqual({ baseline: 12_000, conversation: 2_000 })
    expect(state.context.categories).toEqual(categories(15_000))
    expect(state.context.categoriesMeasuredAt).toBe(60)
    expect(state.context.categoriesSessionId).toBe('s1')
    // A later reading of the same session leaves it standing.
    expect(fold([measured(14_000), context(16_000, 200_000)]).context.categories).toEqual(categories(14_000))
  })

  it.each([
    ['a new session', { type: 'session', engine: 'claude', sessionId: 's1', fresh: true, fingerprint: 'f', at: 70 }],
    ['a compaction', { type: 'compaction', engine: 'claude', sessionId: 's1', at: 70 }],
    ['a reading from another session', { type: 'context', engine: 'claude', sessionId: 's2', used: 10, costed: false, at: 70 }]
  ] as [string, SessionTelemetryChange][])('drops the measurement on %s', (_label, reset) => {
    const state = fold([measured(14_000), reset])
    expect(state.context.categories).toBeUndefined()
    expect(state.context.categoriesMeasuredAt).toBeUndefined()
    expect(state.context.categoriesSessionId).toBeUndefined()
  })

  it('ignores a measurement of another session than the context’s, and takes one before any reading', () => {
    const state = fold([context(16_000, 200_000), measured(14_000, 50, 's_old')])
    expect(state.context.sessionId).toBe('s1')
    expect(state.context.categories).toBeUndefined()
    expect(fold([measured(14_000, 50, 's_first')]).context.categoriesSessionId).toBe('s_first')
  })

  it('keeps the measurement through a model switch and a reload under other params, which reset no baseline', () => {
    const state = fold([
      { type: 'model', engine: 'claude', selected: 'sonnet' },
      { type: 'session', engine: 'claude', sessionId: 's1', fresh: false, fingerprint: 'a', at: 1 },
      measured(14_000),
      { type: 'model', engine: 'claude', selected: 'opus' },
      { type: 'session', engine: 'claude', sessionId: 's1', fresh: false, fingerprint: 'b', at: 80 }
    ])
    expect(state.context.categories).toEqual(categories(14_000))
  })

  it('keeps the session’s last running token total, without adding it to the totals', () => {
    const state = fold([
      { ...turn({ model: 'gpt-5.5', tokens: tally(50, 5, 900) }, { tokenTotalReading: tally(150, 25, 2_900) }), engine: 'codex' },
      { ...turn({ model: 'gpt-5.5', tokens: tally(10, 5, 1_000) }, { tokenTotalReading: tally(160, 30, 3_900) }), engine: 'codex' }
    ])
    expect(state.totals.bySession.s1.lastTokenTotal).toEqual(tally(160, 30, 3_900))
    expect(state.totals.tokens).toEqual(tally(60, 10, 1_900))
    expect(state.totals.tokenScope).toBe('turn')
  })
})
