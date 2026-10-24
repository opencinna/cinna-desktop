import { describe, expect, it } from 'vitest'
import { aiFunctionRuntimePoolKey, syntheticRuntimePoolKey } from './syntheticRuntimePooling'
import type { ConductorContext } from './chatConductorService'

const context: ConductorContext = { engine: 'opencode', credentialId: 'credential', modelId: 'model', instructions: 'Be helpful.', toolPolicy: 'connectors', complexity: null, path: '/owned/chat-one' }

describe('synthetic runtime process grouping', () => {
  it('shares identical runtime/prompt/policy within a profile without sharing session folders', () => {
    expect(syntheticRuntimePoolKey('profile', context)).toBe(syntheticRuntimePoolKey('profile', { ...context, path: '/owned/chat-two' }))
    expect(context.path).toBe('/owned/chat-one')
  })
  it.each([
    { credentialId: 'another' }, { modelId: 'other' }, { instructions: 'Different mode' },
    { toolPolicy: 'none' as const }, { toolPolicy: 'workspace' as const }, { engine: 'claude' as const }, { complexity: 'complex' as const }
  ])('keeps incompatible runtime settings in different processes: %j', (changed) => {
    expect(syntheticRuntimePoolKey('profile', context)).not.toBe(syntheticRuntimePoolKey('profile', { ...context, ...changed }))
  })
  it('a Claude auth fingerprint keeps chats on different accounts apart, and its absence keeps old keys', () => {
    const claude = { ...context, engine: 'claude' as const }
    expect(syntheticRuntimePoolKey('profile', claude, 'subscription')).not.toBe(syntheticRuntimePoolKey('profile', claude, 'api_key:abc'))
    expect(syntheticRuntimePoolKey('profile', claude, 'api_key:abc')).not.toBe(syntheticRuntimePoolKey('profile', claude, 'api_key:def'))
    expect(syntheticRuntimePoolKey('profile', claude, null)).toBe(syntheticRuntimePoolKey('profile', claude))
  })
  it('an AI function’s process is keyed by the Claude auth fingerprint too', () => {
    const key = (fingerprint: string | null) => aiFunctionRuntimePoolKey('profile', 'claude', null, 'sonnet', null, fingerprint)
    expect(key('subscription')).not.toBe(key('api_key:abc'))
    expect(key(null)).toBe(aiFunctionRuntimePoolKey('profile', 'claude', null, 'sonnet', null))
  })
  it('never shares across profiles', () => {
    expect(syntheticRuntimePoolKey('profile', context)).not.toBe(syntheticRuntimePoolKey('other-profile', context))
  })
})
