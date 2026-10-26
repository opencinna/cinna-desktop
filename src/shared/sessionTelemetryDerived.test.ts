import { describe, expect, it } from 'vitest'
import type { SessionTelemetry } from './sessionTelemetry'
import { CACHE_NOTICE_MIN_CONTEXT_TOKENS, cacheExpiryNotice, cacheHitRatio, cacheState, contextCategoryKind, currentPrices, nextMessageEstimate } from './sessionTelemetryDerived'

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

  it('keep the base rates in fast mode for a model with no listed fast rate, flagged', () => {
    const fast = currentPrices(telemetry({ runtime: { fastMode: 'on' } }))
    expect(fast).toMatchObject({ prices: { input: 2, output: 10, cacheRead: 0.2 }, fast: true, fastPriceUnknown: true })
    expect(currentPrices(telemetry())?.fastPriceUnknown).toBe(false)
    expect(currentPrices(telemetry({ model: { resolved: 'claude-opus-5-5', source: 'init' }, runtime: { fastMode: 'on' } }))?.fastPriceUnknown).toBe(false)
  })

  it('give the next message no figures in fast mode without a fast rate, and say so', () => {
    expect(nextMessageEstimate(telemetry({ runtime: { fastMode: 'on' } }), NOW)).toEqual({ basis: 'api', note: 'Price unknown in fast mode.' })
  })
})

describe('a measured context category', () => {
  it('is free space or a compaction reserve by exact name, any case; else content', () => {
    expect(contextCategoryKind('Free space')).toBe('free')
    expect(contextCategoryKind('free SPACE')).toBe('free')
    expect(contextCategoryKind('Autocompact buffer')).toBe('reserved')
    expect(contextCategoryKind('Compact buffer')).toBe('reserved')
    expect(contextCategoryKind('Messages')).toBe('content')
    expect(contextCategoryKind('Free space used by tools')).toBe('content')
  })
})

describe('the cache hit ratio', () => {
  it('is reads over reads, writes and uncached input, for the session and the last turn', () => {
    const t = telemetry({ totals: { ...telemetry().totals, lastTurn: { input: 0, output: 5, cacheRead: 3, cacheWrite: 1 } } })
    expect(cacheHitRatio(t)).toEqual({ session: 0.8, lastTurn: 0.75 })
    expect(cacheHitRatio(telemetry({ totals: { ...telemetry().totals, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }))).toEqual({})
  })
})

describe('the cache-expiry notice', () => {
  const HOUR = 60 * MIN
  /** A session idle for `idleMs` at NOW, on `engine` and `model`, its cache clock as the reducer leaves it. */
  const idle = (engine: SessionTelemetry['engine'], model: string, idleMs: number, patch: Partial<SessionTelemetry> = {}): SessionTelemetry =>
    telemetry({
      engine,
      model: { selected: model, source: 'config' },
      cache: engine === 'claude'
        ? { lastRequestAt: NOW - idleMs, ttlMs: 5 * MIN, ttlSource: 'assumed', expiresAt: NOW - idleMs + 5 * MIN }
        : { lastRequestAt: NOW - idleMs, ttlSource: 'assumed' },
      ...patch
    })

  /** Each engine and provider at the edges of its typical and longest TTL. */
  const bounds: { name: string; engine: SessionTelemetry['engine']; model: string; typical: number; max: number }[] = [
    { name: 'Claude (5m assumed)', engine: 'claude', model: 'claude-sonnet-5', typical: 5 * MIN, max: HOUR },
    { name: 'Codex', engine: 'codex', model: 'gpt-5.5', typical: HOUR, max: 24 * HOUR },
    { name: 'Antigravity', engine: 'antigravity', model: 'gemini-3.6-flash-low', typical: HOUR, max: 24 * HOUR },
    { name: 'OpenCode on Anthropic', engine: 'opencode', model: 'anthropic/claude-sonnet-5', typical: 5 * MIN, max: HOUR },
    { name: 'OpenCode on a second Anthropic key', engine: 'opencode', model: 'anthropic-1a2b3c4d/claude-sonnet-5', typical: 5 * MIN, max: HOUR },
    { name: 'OpenCode on OpenAI', engine: 'opencode', model: 'openai/gpt-5.5', typical: HOUR, max: 24 * HOUR },
    { name: 'OpenCode on Gemini', engine: 'opencode', model: 'gemini-1a2b3c4d/gemini-3.6-flash', typical: HOUR, max: 24 * HOUR },
    { name: 'OpenCode on a gateway', engine: 'opencode', model: 'openai-compatible-1a2b3c4d/gpt-5.5', typical: HOUR, max: 24 * HOUR }
  ]
  for (const { name, engine, model, typical, max } of bounds) {
    it(`${name}: nothing under its usual TTL, probably past it, expired past its longest`, () => {
      const level = (idleMs: number) => cacheExpiryNotice(idle(engine, model, idleMs), NOW)?.level ?? null
      expect(level(typical - 1)).toBeNull()
      expect(level(typical + 1)).toBe('probably_expired')
      expect(level(max - 1)).toBe('probably_expired')
      expect(level(max + 1)).toBe('expired')
      expect(cacheExpiryNotice(idle(engine, model, max + 1), NOW)).toMatchObject({ reason: 'idle', idleMs: max + 1, contextTokens: 100_000 })
    })
  }

  it('Claude with an observed 1h TTL: nothing for an hour, then certainly expired', () => {
    const observed = (idleMs: number) =>
      idle('claude', 'claude-sonnet-5', idleMs, { cache: { lastRequestAt: NOW - idleMs, ttlMs: HOUR, ttlSource: 'observed', expiresAt: NOW - idleMs + HOUR } })
    expect(cacheExpiryNotice(observed(5 * MIN + 1), NOW)).toBeNull()
    expect(cacheExpiryNotice(observed(HOUR - 1), NOW)).toBeNull()
    expect(cacheExpiryNotice(observed(HOUR + 1), NOW)?.level).toBe('expired')
  })

  it('is expired by an invalidation after the last request, whatever the idle time, and names it', () => {
    const base = idle('claude', 'claude-sonnet-5', MIN)
    const invalidated = { ...base, cache: { ...base.cache, invalidatedAt: NOW - 30_000, invalidationReason: 'model_change' as const } }
    expect(cacheExpiryNotice(invalidated, NOW)).toMatchObject({ level: 'expired', reason: 'model_change', idleMs: MIN })
    // One at the same moment as the request counts too.
    const same = { ...base, cache: { ...base.cache, invalidatedAt: NOW - MIN, invalidationReason: 'new_session' as const } }
    expect(cacheExpiryNotice(same, NOW)).toMatchObject({ level: 'expired', reason: 'new_session' })
  })

  it('is cleared by a new request after the invalidation', () => {
    const base = idle('claude', 'claude-sonnet-5', MIN)
    const rewritten = { ...base, cache: { ...base.cache, invalidatedAt: NOW - 2 * MIN, invalidationReason: 'compaction' as const } }
    expect(cacheExpiryNotice(rewritten, NOW)).toBeNull()
  })

  it('needs a context of at least 50K tokens', () => {
    expect(CACHE_NOTICE_MIN_CONTEXT_TOKENS).toBe(50_000)
    const at = (used: number) => cacheExpiryNotice(idle('codex', 'gpt-5.5', 2 * HOUR, { context: { used, size: 400_000, sizeAuthoritative: true } }), NOW)
    expect(at(49_999)).toBeNull()
    expect(at(50_000)).toMatchObject({ level: 'probably_expired', contextTokens: 50_000 })
  })

  it('is null before any request', () => {
    expect(cacheExpiryNotice(idle('claude', 'claude-sonnet-5', 0, { cache: { ttlSource: 'assumed' } }), NOW)).toBeNull()
    expect(cacheExpiryNotice(idle('opencode', 'openai/gpt-5.5', 0, { cache: { ttlSource: 'assumed' } }), NOW)).toBeNull()
  })

  describe('its estimate', () => {
    const estimate = (t: SessionTelemetry) => cacheExpiryNotice(t, NOW)?.estimate
    it('on an API key: Claude cold at the 5m write rate, warm at the cache read', () => {
      const e = estimate(idle('claude', 'claude-sonnet-5', 2 * HOUR))
      expect(e?.basis).toBe('api')
      expect(e?.coldUsd).toBeCloseTo((100_000 * 2.5) / 1_000_000)
      expect(e?.warmUsd).toBeCloseTo((100_000 * 0.2) / 1_000_000)
    })

    it('on an API key: Claude with a 1h TTL cold at the 1h write rate', () => {
      const t = idle('claude', 'claude-sonnet-5', 2 * HOUR, { cache: { lastRequestAt: NOW - 2 * HOUR, ttlMs: HOUR, ttlSource: 'observed', expiresAt: NOW - HOUR } })
      expect(estimate(t)?.coldUsd).toBeCloseTo((100_000 * 4) / 1_000_000)
    })

    it('on an API key: OpenAI-priced models cold at the input price, warm at the cache read', () => {
      for (const t of [idle('codex', 'gpt-5.5', 2 * HOUR), idle('opencode', 'openai/gpt-5.5', 2 * HOUR, { auth: { kind: 'unknown' } })]) {
        const e = estimate(t)
        expect(e?.basis).toBe('api')
        expect(e?.coldUsd).toBeCloseTo((100_000 * 5) / 1_000_000)
        expect(e?.warmUsd).toBeCloseTo((100_000 * 0.5) / 1_000_000)
      }
    })

    it('on OpenCode’s Anthropic key: priced as Claude, at the 5m write rate', () => {
      expect(estimate(idle('opencode', 'anthropic/claude-sonnet-5', 2 * HOUR))?.coldUsd).toBeCloseTo((100_000 * 2.5) / 1_000_000)
    })

    it('on a subscription: no dollars, said so', () => {
      expect(estimate(idle('claude', 'claude-sonnet-5', 2 * HOUR, { auth: { kind: 'subscription', label: 'Claude Max' } }))).toEqual({ basis: 'subscription' })
      expect(estimate(idle('codex', 'gpt-5.5', 2 * HOUR, { auth: { kind: 'subscription', label: 'ChatGPT' } }))).toEqual({ basis: 'subscription' })
    })

    it('tokens only for an unknown price, a partner cloud, or an OpenCode provider that resells', () => {
      expect(estimate(idle('claude', 'claude-unknown-9', 2 * HOUR))).toEqual({ basis: 'none' })
      expect(estimate(idle('antigravity', 'gemini-3.6-flash-low', 2 * HOUR))).toEqual({ basis: 'none' })
      expect(estimate(idle('claude', 'claude-sonnet-5', 2 * HOUR, { auth: { kind: 'cloud' } }))).toEqual({ basis: 'none' })
      expect(estimate(idle('opencode', 'openai-compatible-1a2b3c4d/gpt-5.5', 2 * HOUR))).toEqual({ basis: 'none' })
      expect(estimate(idle('opencode', 'openrouter/openai/gpt-5.5', 2 * HOUR))).toEqual({ basis: 'none' })
    })
  })
})
