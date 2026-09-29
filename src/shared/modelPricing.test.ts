import { describe, expect, it } from 'vitest'
import { canonicalPricingModel, costOf, effectivePrices, PRICES_CHECKED_AT, priceOf } from './modelPricing'

const M = 1_000_000
const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cacheWrite1h?: number) =>
  ({ input, output, cacheRead, cacheWrite, ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}) })

describe('the model price table', () => {
  it('says when it was checked', () => {
    expect(PRICES_CHECKED_AT).toBe('2026-09-29')
  })

  it('canonicalizes variants, dates and cloud spellings to the table’s ids', () => {
    expect(canonicalPricingModel('claude-sonnet-5[1m]')).toBe('claude-sonnet-5')
    expect(canonicalPricingModel('Claude-Haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(canonicalPricingModel('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5')
    expect(canonicalPricingModel('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe('claude-opus-4-1')
    expect(canonicalPricingModel('global.anthropic.claude-opus-5-5-v1')).toBe('claude-opus-5-5')
    expect(canonicalPricingModel('claude-opus-4-1@20250805')).toBe('claude-opus-4-1')
    expect(canonicalPricingModel('gpt-6.1-sol')).toBe('gpt-6.1-sol')
    expect(priceOf('claude-sonnet-5[1m]')).toMatchObject({ input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 })
    expect(priceOf('claude-opus-4-1@20250805')).toMatchObject({ input: 15, output: 75 })
  })

  it('knows no price for an unlisted model, and never guesses a near one', () => {
    expect(priceOf('gpt-5.5-codex')).toBeUndefined()
    expect(priceOf('claude-sonnet-6')).toBeUndefined()
    expect(priceOf('claude-opus')).toBeUndefined()
    expect(priceOf(undefined)).toBeUndefined()
    expect(priceOf('toString')).toBeUndefined()
    expect(costOf('gpt-5.5-codex', tokens(1_000, 1_000))).toBeUndefined()
  })

  it('prices Claude input, output, reads and writes at the write TTL', () => {
    // Sonnet 5: 2 / 2.50 (5m) / 4 (1h) / 0.20 / 10.
    expect(costOf('claude-sonnet-5', tokens(M, M, M, M))).toBeCloseTo(2 + 10 + 0.2 + 2.5)
    expect(costOf('claude-sonnet-5', tokens(0, 0, 0, M), { ttl: '1h' })).toBeCloseTo(4)
    // Split writes: 1h part at the 1h price, the rest at the TTL's.
    expect(costOf('claude-sonnet-5', tokens(0, 0, 0, M, M / 4))).toBeCloseTo(0.75 * 2.5 + 0.25 * 4)
  })

  it('prices OpenAI cache writes as input and switches to the long-context tier above 272K', () => {
    expect(costOf('gpt-5.5', tokens(M, M, M), { contextTokens: 272_000 })).toBeCloseTo(5 + 30 + 0.5)
    expect(costOf('gpt-5.5', tokens(M, M, M, M), { contextTokens: 272_001 })).toBeCloseTo(10 + 45 + 1 + 10)
    expect(priceOf('gpt-5.4-mini')?.longContext).toBeUndefined()
    expect(costOf('gpt-5.4-mini', tokens(M, 0), { contextTokens: 500_000 })).toBeCloseTo(0.75)
  })

  it('gives no estimate past a premium it does not model (Sonnet 4.5 above 200K), and prices 4.6 flat', () => {
    expect(costOf('claude-sonnet-4-5-20250929', tokens(M, 0), { contextTokens: 200_000 })).toBeCloseTo(3)
    expect(costOf('claude-sonnet-4-5-20250929', tokens(M, 0), { contextTokens: 200_001 })).toBeUndefined()
    expect(costOf('claude-sonnet-4-6', tokens(M, 0), { contextTokens: 900_000 })).toBeCloseTo(3)
  })

  it('applies fast-mode prices with the caching multipliers on top of the fast input price', () => {
    const opus = priceOf('claude-opus-4-8')!
    expect(effectivePrices(opus, { fast: true })).toEqual({ input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 })
    const opus55 = effectivePrices(priceOf('claude-opus-5-5')!, { fast: true })!
    expect(opus55.input).toBe(8)
    expect(opus55.output).toBe(40)
    expect(opus55.cacheWrite5m).toBeCloseTo(10)
    expect(opus55.cacheWrite1h).toBeCloseTo(16)
    expect(opus55.cacheRead).toBeCloseTo(0.4)
    // A model without fast prices has none in fast mode.
    expect(costOf('claude-sonnet-5', tokens(M, 0), { fast: true })).toBeUndefined()
  })
})
