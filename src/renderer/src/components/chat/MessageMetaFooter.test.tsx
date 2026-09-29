import { describe, expect, it } from 'vitest'
import { buildMeta } from './MessageMetaFooter'

type Msg = Parameters<typeof buildMeta>[0]

const base: Msg = { id: 'm1', chatId: 'c1', role: 'assistant', content: 'Hi', sortOrder: 0, createdAt: new Date(0) }

describe('the message metadata popup', () => {
  it('adds the turn’s model, tokens, cost and duration when the row has telemetry', () => {
    const meta = buildMeta({ ...base, telemetry: {
      model: 'claude-sonnet-5[1m]', tokens: { input: 15, output: 320, cacheRead: 38_000, cacheWrite: 2_400 },
      tokenScope: 'turn', costUsd: 0.04, costSource: 'runtime', durationMs: 1_500, contextUsedAfter: 16_400
    } })
    expect(meta.telemetry).toEqual({
      model: 'claude-sonnet-5[1m]',
      tokens: { scope: 'turn', input: 15, output: 320, cacheRead: 38_000, cacheWrite: 2_400 },
      cost: '$0.04',
      durationMs: 1_500
    })
    // Ahead of `parts`, which can push it below the popup's fold.
    expect(Object.keys(buildMeta({ ...base, parts: [{ kind: 'text', text: 'Hi' }], telemetry: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokenScope: 'turn', costSource: 'runtime' } })).slice(-2))
      .toEqual(['telemetry', 'parts'])
  })

  it('says a Codex count is the last request only, and shows no tokens a follow-up never reported', () => {
    expect(buildMeta({ ...base, telemetry: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 }, tokenScope: 'last_request', costSource: 'runtime' } }))
      .toMatchObject({ telemetry: { tokens: { scope: 'last request only (lower bound)', input: 1 } } })
    const followUp = buildMeta({ ...base, telemetry: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokenScope: 'none', costUsd: 0.04, costSource: 'runtime' } })
    expect(followUp.telemetry).toEqual({ tokens: 'not reported (follow-up turn)', cost: '$0.04' })
  })

  it('marks a cost the app estimated rather than the runtime reported', () => {
    expect(buildMeta({ ...base, telemetry: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokenScope: 'last_request', costUsd: 0.0412345, costSource: 'estimated' } }).telemetry)
      .toMatchObject({ cost: '$0.04123 (estimated)' })
  })

  it('adds nothing without telemetry', () => {
    expect(Object.keys(buildMeta(base))).toEqual(['id', 'role', 'createdAt', 'sortOrder', 'chatId', 'contentLength'])
  })
})
