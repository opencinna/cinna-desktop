import { describe, expect, it } from 'vitest'
import { CACHE_TTL_BOUNDS, cacheProviderOf, opencodeProviderKeyOf, pricingModelId, TTL_CHECKED_AT } from './promptCacheTtl'

const MIN = 60_000
const HOUR = 60 * MIN

describe('the prompt-cache provider', () => {
  it('is fixed per engine for Claude, Codex and Antigravity', () => {
    expect(cacheProviderOf('claude', 'opus')).toBe('anthropic')
    expect(cacheProviderOf('codex', 'gpt-5.5')).toBe('openai')
    expect(cacheProviderOf('antigravity', 'gemini-3.6-flash-low')).toBe('google')
  })

  it('comes from an OpenCode model id’s provider key', () => {
    expect(cacheProviderOf('opencode', 'anthropic/claude-sonnet-5')).toBe('anthropic')
    expect(cacheProviderOf('opencode', 'anthropic-1a2b3c4d/claude-sonnet-5')).toBe('anthropic')
    expect(cacheProviderOf('opencode', 'openai/gpt-5.5')).toBe('openai')
    expect(cacheProviderOf('opencode', 'openai-0f9e8d7c/gpt-5.5')).toBe('openai')
    expect(cacheProviderOf('opencode', 'gemini-1a2b3c4d/gemini-3.6-flash')).toBe('google')
    expect(cacheProviderOf('opencode', 'google/gemini-3.6-flash')).toBe('google')
    // A gateway is not the provider it imitates.
    expect(cacheProviderOf('opencode', 'openai-compatible-1a2b3c4d/gpt-5.5')).toBe('unknown')
    expect(cacheProviderOf('opencode', 'ollama-1a2b3c4d/llama3')).toBe('unknown')
    expect(cacheProviderOf('opencode', 'gpt-5.5')).toBe('unknown')
    expect(cacheProviderOf('opencode', undefined)).toBe('unknown')
    expect(opencodeProviderKeyOf('Anthropic/claude-sonnet-5')).toBe('anthropic')
  })
})

describe('the model id a price is looked up under', () => {
  it('loses an OpenCode prefix only for Anthropic’s and OpenAI’s own APIs', () => {
    expect(pricingModelId('opencode', 'anthropic/claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(pricingModelId('opencode', 'openai-0f9e8d7c/gpt-5.5')).toBe('gpt-5.5')
    expect(pricingModelId('opencode', 'gemini-1a2b3c4d/gemini-3.6-flash')).toBeUndefined()
    expect(pricingModelId('opencode', 'openrouter/openai/gpt-5.5')).toBeUndefined()
  })

  it('is the id itself on other engines', () => {
    expect(pricingModelId('claude', 'claude-sonnet-5[1m]')).toBe('claude-sonnet-5[1m]')
    expect(pricingModelId('codex', 'gpt-5.5')).toBe('gpt-5.5')
  })
})

describe('the TTL table', () => {
  it('is dated and holds the documented bounds', () => {
    expect(TTL_CHECKED_AT).toBe('2026-10-26')
    expect(CACHE_TTL_BOUNDS).toEqual({
      anthropic: { typicalMs: 5 * MIN, maxMs: HOUR },
      openai: { typicalMs: HOUR, maxMs: 24 * HOUR },
      google: { typicalMs: HOUR, maxMs: 24 * HOUR },
      unknown: { typicalMs: HOUR, maxMs: 24 * HOUR }
    })
  })
})
