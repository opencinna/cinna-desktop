import { describe, expect, it } from 'vitest'
import { syntheticRuntimePoolKey } from './syntheticRuntimePooling'
import type { ConductorContext } from './chatConductorService'

const context: ConductorContext = { engine: 'opencode', credentialId: 'credential', modelId: 'model', instructions: 'Be helpful.', toolPolicy: 'connectors', path: '/owned/chat-one' }

describe('synthetic runtime process grouping', () => {
  it('shares identical runtime/prompt/policy within a profile without sharing session folders', () => {
    expect(syntheticRuntimePoolKey('profile', context)).toBe(syntheticRuntimePoolKey('profile', { ...context, path: '/owned/chat-two' }))
    expect(context.path).toBe('/owned/chat-one')
  })
  it.each([
    { credentialId: 'another' }, { modelId: 'other' }, { instructions: 'Different mode' },
    { toolPolicy: 'none' as const }, { engine: 'claude' as const }
  ])('keeps incompatible runtime settings in different processes: %j', (changed) => {
    expect(syntheticRuntimePoolKey('profile', context)).not.toBe(syntheticRuntimePoolKey('profile', { ...context, ...changed }))
  })
  it('never shares across profiles', () => {
    expect(syntheticRuntimePoolKey('profile', context)).not.toBe(syntheticRuntimePoolKey('other-profile', context))
  })
})
