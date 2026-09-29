import { describe, expect, it } from 'vitest'
import type { MessageTelemetry, SessionTelemetry, SessionTelemetryChange, TokenTally } from '../../../shared/sessionTelemetry'
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
