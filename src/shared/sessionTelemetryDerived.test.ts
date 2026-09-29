import { describe, expect, it } from 'vitest'
import type { SessionTelemetry } from './sessionTelemetry'
import { cacheHitRatio, cacheState, currentPrices, nextMessageEstimate } from './sessionTelemetryDerived'

const NOW = 1_000_000_000
const MIN = 60_000

function telemetry(patch: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    chatId: 'chat',
    engine: 'claude',
    auth: { kind: 'api_key' },
    model: { resolved: 'claude-sonnet-5[1m]', source: 'init' },
    context: { used: 100_000, size: 1_000_000, sizeAuthoritative: true },
    totals: {
      tokens: { input: 100, output: 1_000, cacheRead: 8_000, cacheWrite: 1_900 },
      costSource: 'runtime',
      turns: 1,
      tokenScope: 'turn',
      byModel: {},
      bySession: {}
    },
    cache: { lastRequestAt: NOW - 2 * MIN, ttlMs: 5 * MIN, ttlSource: 'observed', expiresAt: NOW + 3 * MIN },
    updatedAt: NOW,
    ...patch
  }
}

describe('the cache state', () => {
  it('is warm until it expires, then cold', () => {
    expect(cacheState(telemetry(), NOW)).toEqual({ state: 'warm', flipsAt: NOW + 3 * MIN })
    expect(cacheState(telemetry(), NOW + 3 * MIN)).toEqual({ state: 'cold' })
  })

  it('is cold after an invalidation no request has followed, and warm again after one', () => {
    const invalidated = telemetry({ cache: { ...telemetry().cache, invalidatedAt: NOW - MIN, invalidationReason: 'model_change' } })
    expect(cacheState(invalidated, NOW)).toEqual({ state: 'cold' })
    const rewritten = telemetry({ cache: { ...invalidated.cache, lastRequestAt: NOW - 30_000, expiresAt: NOW + 4.5 * MIN } })
    expect(cacheState(rewritten, NOW).state).toBe('warm')
  })

  it('is unknown before any request, and always for Codex', () => {
    expect(cacheState(telemetry({ cache: { ttlSource: 'assumed' } }), NOW)).toEqual({ state: 'unknown' })
    expect(cacheState(telemetry({ engine: 'codex' }), NOW)).toEqual({ state: 'unknown' })
  })
})

describe('the next message’s pre-context price', () => {
  it('is used × cache read warm and used × 5m write cold for Claude, with the flip time', () => {
    const estimate = nextMessageEstimate(telemetry(), NOW)
    expect(estimate.warmUsd).toBeCloseTo(0.1 * 0.2)
    expect(estimate.coldUsd).toBeCloseTo(0.1 * 2.5)
    expect(estimate.flipsAt).toBe(NOW + 3 * MIN)
    expect(estimate.basis).toBe('api')
    expect(estimate.note).toMatch(/once per request/)
  })

  it('writes cold at the 1h price when the TTL is 1h, and has no flip time once cold', () => {
    const estimate = nextMessageEstimate(telemetry({ cache: { lastRequestAt: NOW - 2 * 60 * MIN, ttlMs: 60 * MIN, ttlSource: 'observed', expiresAt: NOW - 60 * MIN } }), NOW)
    expect(estimate.coldUsd).toBeCloseTo(0.1 * 4)
    expect(estimate.flipsAt).toBeUndefined()
  })

  it('is labelled API-equivalent on a subscription', () => {
    expect(nextMessageEstimate(telemetry({ auth: { kind: 'subscription', plan: 'max' } }), NOW).basis).toBe('api_equivalent')
  })

  it('is only an uncached upper bound for Codex', () => {
    const estimate = nextMessageEstimate(telemetry({ engine: 'codex', model: { resolved: 'gpt-5.5', source: 'quota' }, cache: { ttlSource: 'assumed' } }), NOW)
    expect(estimate.warmUsd).toBeUndefined()
    expect(estimate.coldUsd).toBeCloseTo(0.1 * 5)
    expect(estimate.note).toMatch(/Upper bound/)
  })

  it('gives no figures for an unknown model or a partner cloud', () => {
    const unknown = nextMessageEstimate(telemetry({ model: { resolved: 'gpt-5.5-codex', source: 'quota' } }), NOW)
    expect(unknown).toEqual({ basis: 'api', note: 'Price unknown for this model.' })
    const cloud = nextMessageEstimate(telemetry({ auth: { kind: 'cloud' } }), NOW)
    expect(cloud.warmUsd).toBeUndefined()
    expect(cloud.coldUsd).toBeUndefined()
  })
})

describe('the current prices', () => {
  it('are the resolved model’s, at the context size’s tier and in fast mode', () => {
    expect(currentPrices(telemetry())).toMatchObject({ model: 'claude-sonnet-5[1m]', prices: { input: 2, cacheRead: 0.2 }, fast: false, longContext: false, checkedAt: '2026-09-29' })
    const long = currentPrices(telemetry({ engine: 'codex', model: { resolved: 'gpt-5.5', source: 'quota' }, context: { used: 300_000, size: 1_000_000, sizeAuthoritative: true } }))
    expect(long).toMatchObject({ prices: { input: 10, output: 45 }, longContext: true })
    const fast = currentPrices(telemetry({ model: { resolved: 'claude-opus-5-5', source: 'init' }, runtime: { fastMode: 'on' } }))
    expect(fast).toMatchObject({ prices: { input: 8, output: 40 }, fast: true })
    expect(currentPrices(telemetry({ model: { selected: 'default', source: 'config' } }))).toBeUndefined()
  })
})

describe('the cache hit ratio', () => {
  it('is reads over reads, writes and uncached input, for the session and the last turn', () => {
    const t = telemetry({ totals: { ...telemetry().totals, lastTurn: { input: 0, output: 5, cacheRead: 3, cacheWrite: 1 } } })
    expect(cacheHitRatio(t)).toEqual({ session: 0.8, lastTurn: 0.75 })
    expect(cacheHitRatio(telemetry({ totals: { ...telemetry().totals, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }))).toEqual({})
  })
})
