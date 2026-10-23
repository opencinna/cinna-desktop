import { describe, expect, it } from 'vitest'
import { isClaudeApiCredential, isClaudeAuthMode, pickClaudeApiCredential } from './claudeAuthMode'

const anthropic = (id: string, over: Partial<{ enabled: boolean; hasApiKey: boolean; unsupported: boolean; type: string }> = {}) =>
  ({ id, type: 'anthropic', enabled: true, hasApiKey: true, unsupported: false, ...over })

describe('isClaudeApiCredential', () => {
  it('is an enabled Anthropic credential with a key', () => {
    expect(isClaudeApiCredential(anthropic('a'))).toBe(true)
  })
  it.each([
    ['switched off', { enabled: false }],
    ['keyless', { hasApiKey: false }],
    ['an account OAuth token the API refuses', { unsupported: true }],
    ['another vendor', { type: 'openai' }]
  ])('refuses one that is %s', (_why, over) => {
    expect(isClaudeApiCredential(anthropic('a', over))).toBe(false)
  })
})

describe('pickClaudeApiCredential', () => {
  const list = [anthropic('first'), { ...anthropic('openai'), type: 'openai' }, anthropic('preferred'), anthropic('off', { enabled: false })]

  it('automatic: the preferred (Default AI) credential when it is Anthropic, else the first that qualifies', () => {
    expect(pickClaudeApiCredential(list, '', 'preferred')?.id).toBe('preferred')
    expect(pickClaudeApiCredential(list, '', 'openai')?.id).toBe('first')
    expect(pickClaudeApiCredential(list, '', null)?.id).toBe('first')
  })

  it('a named credential wins over the preferred one', () => {
    expect(pickClaudeApiCredential(list, 'preferred', 'first')?.id).toBe('preferred')
  })

  it('a named credential that no longer qualifies is null, never another key', () => {
    expect(pickClaudeApiCredential(list, 'off', null)).toBeNull()
    expect(pickClaudeApiCredential(list, 'deleted', 'first')).toBeNull()
  })

  it('nothing qualifies: null', () => {
    expect(pickClaudeApiCredential([anthropic('x', { hasApiKey: false })], '', null)).toBeNull()
  })
})

describe('isClaudeAuthMode', () => {
  it('knows the two modes and nothing else', () => {
    expect(isClaudeAuthMode('subscription')).toBe(true)
    expect(isClaudeAuthMode('api_key')).toBe(true)
    expect(isClaudeAuthMode('bedrock')).toBe(false)
    expect(isClaudeAuthMode('')).toBe(false)
  })
})
