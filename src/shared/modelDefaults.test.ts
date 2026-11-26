import { describe, expect, it } from 'vitest'
import { isDefaultEligibleModelId, pickDefaultModelId } from './modelDefaults'

describe('isDefaultEligibleModelId', () => {
  it.each([
    'gpt-5-pro',
    'gpt-5.6-pro',
    'gpt-5.4-pro-2025-10-06',
    'o3-pro',
    'o1-pro',
    'openai/gpt-5.6-pro',
    'claude-fable-5-1',
    'claude-mythos-preview'
  ])('refuses %s as an auto-default', (id) => {
    expect(isDefaultEligibleModelId(id)).toBe(false)
  })

  it.each([
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5',
    'o3',
    'gemini-2.5-pro',
    'gemini-3-pro-preview',
    'google/gemini-2.5-pro',
    'claude-opus-4-1'
  ])('accepts %s', (id) => {
    expect(isDefaultEligibleModelId(id)).toBe(true)
  })
})

describe('pickDefaultModelId', () => {
  it('skips a newest-first OpenAI pro for the next eligible model', () => {
    expect(pickDefaultModelId(['gpt-5.6-pro', 'o3-pro', 'gpt-5.6-sol', 'gpt-5.6'])).toBe(
      'gpt-5.6-sol'
    )
  })

  it('keeps Gemini pro as a default', () => {
    expect(pickDefaultModelId(['gemini-2.5-pro', 'gemini-2.5-flash'])).toBe('gemini-2.5-pro')
  })

  it('still returns a pro when the list holds nothing else to chat with', () => {
    // Something beats nothing: a null default leaves the user with no model at all,
    // and the embedding the list also carries cannot chat.
    expect(pickDefaultModelId(['gpt-5.6-pro', 'text-embedding-3-large', 'o3-pro'])).toBe(
      'gpt-5.6-pro'
    )
    expect(pickDefaultModelId(['o3-pro'])).toBe('o3-pro')
  })

  it('skips gated Anthropic tiers and non-chat models as before', () => {
    expect(pickDefaultModelId(['claude-fable-5-1', 'claude-opus-5'])).toBe('claude-opus-5')
    expect(pickDefaultModelId(['text-embedding-3-large', 'gpt-5'])).toBe('gpt-5')
  })

  it('returns null for an empty list', () => {
    expect(pickDefaultModelId([])).toBeNull()
  })
})
