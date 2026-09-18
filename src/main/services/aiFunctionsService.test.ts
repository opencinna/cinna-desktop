import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter } from '../llm/types'

const state = vi.hoisted(() => ({
  settings: { aiFunctionsCredentialId: '', aiFunctionsModelId: '' },
  provider: { id: 'credential', name: 'Work key', type: 'openai', enabled: true, unsupported: false, apiKeyEncrypted: Buffer.from('encrypted') as Buffer | null, defaultModelId: 'default-model' as string | null, availableModels: [] as string[], baseUrl: null },
  stream: vi.fn(), runtime: vi.fn(), lookup: vi.fn(), warn: vi.fn(), createAdapter: vi.fn(), decrypt: vi.fn(),
  providerType: (_type: string): boolean => true
}))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: state.warn, error: () => {} }) }))
vi.mock('../db/appSettings', () => ({ appSettingsRepo: { get: (key: keyof typeof state.settings) => state.settings[key] } }))
vi.mock('../db/llmProviders', () => ({ llmProviderRepo: { getOwned: (...args: unknown[]) => state.lookup(...args) } }))
vi.mock('../security/keystore', () => ({ decryptApiKey: (...args: unknown[]) => state.decrypt(...args) }))
vi.mock('../auth/scope', () => ({ getManagedResourceScopes: () => ['default', 'profile'] }))
vi.mock('../llm/factory', () => ({ isProviderType: (type: string) => state.providerType(type), createAdapter: (...args: unknown[]) => state.createAdapter(...args) }))
vi.mock('./aiFunctionRuntimeService', () => ({ runAiFunctionOnRuntime: (...args: unknown[]) => state.runtime(...args) }))

import { aiFunctions, AI_FUNCTION_TIMEOUT_MS } from './aiFunctionsService'

beforeEach(() => {
  state.settings = { aiFunctionsCredentialId: '', aiFunctionsModelId: '' }
  state.provider.enabled = true
  state.provider.unsupported = false
  state.provider.type = 'openai'
  state.provider.apiKeyEncrypted = Buffer.from('encrypted')
  state.provider.defaultModelId = 'default-model'
  state.provider.availableModels = []
  state.providerType = () => true
  state.createAdapter.mockReset().mockImplementation(() => ({ providerType: 'openai', stream: state.stream }))
  state.decrypt.mockReset().mockReturnValue('decrypted')
  state.lookup.mockReset().mockReturnValue(state.provider)
  state.stream.mockReset().mockResolvedValue({ content: ' answer ' })
  state.runtime.mockReset().mockResolvedValue(' runtime answer ')
})
afterEach(() => vi.useRealTimers())

describe('AI Functions own binding and runtime fallback', () => {
  it('uses the default runtime when its own binding is empty without consulting providers or chat modes', () => {
    expect(aiFunctions.resolveBackend('profile')).toEqual({ kind: 'runtime', userId: 'profile' })
    expect(state.lookup).not.toHaveBeenCalled()
  })
  it('resolves its explicit credential and model, and uses the credential default when the model is empty', () => {
    state.settings = { aiFunctionsCredentialId: 'credential', aiFunctionsModelId: 'own-model' }
    expect(aiFunctions.resolveBackend('profile')).toMatchObject({ kind: 'adapter', modelId: 'own-model' })
    state.settings.aiFunctionsModelId = ''
    expect(aiFunctions.resolveBackend('profile')).toMatchObject({ modelId: 'default-model' })
  })
  it('falls back to the default runtime when the configured credential is disabled, unsupported or deleted', () => {
    state.settings.aiFunctionsCredentialId = 'credential'
    state.provider.enabled = false
    expect(aiFunctions.resolveBackend('profile')).toEqual({ kind: 'runtime', userId: 'profile' })
    state.provider.enabled = true
    state.provider.unsupported = true
    expect(aiFunctions.resolveBackend('profile')).toEqual({ kind: 'runtime', userId: 'profile' })
    state.lookup.mockReturnValue(undefined)
    expect(aiFunctions.resolveBackend('profile')).toEqual({ kind: 'runtime', userId: 'profile' })
    expect(state.lookup).toHaveBeenCalledWith('profile', 'credential')
  })
  it('falls back to the default runtime when the key no longer decrypts', () => {
    state.settings.aiFunctionsCredentialId = 'credential'
    state.decrypt.mockImplementation(() => { throw new Error('keychain reset') })
    expect(aiFunctions.resolveBackend('profile')).toEqual({ kind: 'runtime', userId: 'profile' })
    expect(state.createAdapter).not.toHaveBeenCalled()
  })
  it('warns once per stale credential, not on every call', () => {
    state.settings.aiFunctionsCredentialId = 'gone'
    state.lookup.mockReturnValue(undefined)
    state.warn.mockClear()
    aiFunctions.resolveBackend('profile')
    aiFunctions.resolveBackend('profile')
    expect(state.warn).toHaveBeenCalledTimes(1)
    state.settings.aiFunctionsCredentialId = 'also-gone'
    aiFunctions.resolveBackend('profile')
    expect(state.warn).toHaveBeenCalledTimes(2)
  })
  it.each(['adapter', 'runtime'] as const)('applies the same trimmed output cap to %s', async (kind) => {
    const backend = kind === 'runtime' ? { kind, userId: 'profile' } : { kind, adapter: { stream: state.stream } as unknown as LLMAdapter, modelId: 'model' }
    expect(await aiFunctions.runSingleShot({ backend, systemPrompt: 'title', userText: 'text', maxOutputChars: 3, warmOnly: true })).toBe(kind === 'runtime' ? 'run' : 'ans')
    if (kind === 'runtime') expect(state.runtime).toHaveBeenCalledWith(expect.objectContaining({ warmOnly: true, maxOutputChars: 3, signal: expect.any(AbortSignal) }))
    else expect(state.stream).toHaveBeenCalledWith(expect.objectContaining({ messages: [{ role: 'system', content: 'title' }, { role: 'user', content: 'text' }] }))
  })
  it('aborts and returns within its ceiling even when a provider ignores the signal', async () => {
    vi.useFakeTimers()
    state.runtime.mockImplementation(() => new Promise(() => {}))
    const result = aiFunctions.runSingleShot({ backend: { kind: 'runtime', userId: 'profile' }, systemPrompt: 'title', userText: 'text' })
    const rejected = expect(result).rejects.toMatchObject({ code: 'llm_failed', detail: 'AI function timed out' })
    await vi.advanceTimersByTimeAsync(AI_FUNCTION_TIMEOUT_MS)
    await rejected
    expect(state.runtime.mock.calls[0][0].signal.aborted).toBe(true)
  })
  it('does not dispatch an already-canceled request and reports empty output consistently', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(aiFunctions.runSingleShot({ backend: { kind: 'runtime', userId: 'profile' }, systemPrompt: '', userText: '', signal: controller.signal })).rejects.toMatchObject({ code: 'llm_failed' })
    expect(state.runtime).not.toHaveBeenCalled()
    state.runtime.mockResolvedValue('  ')
    await expect(aiFunctions.runSingleShot({ backend: { kind: 'runtime', userId: 'profile' }, systemPrompt: '', userText: '' })).rejects.toMatchObject({ code: 'empty_output' })
  })
})

/**
 * `describeBackend` is what Settings → Features renders. It must reach the same
 * verdict as `resolveBackend` from the same checks, without decrypting a key or
 * building an adapter.
 */
describe('AI Functions describeBackend', () => {
  const expectNoSideEffects = (): void => {
    expect(state.createAdapter).not.toHaveBeenCalled()
    expect(state.decrypt).not.toHaveBeenCalled()
  }

  it('is unset without consulting providers', () => {
    expect(aiFunctions.describeBackend()).toEqual({ runsOn: 'runtime', reason: 'unset' })
    expect(state.lookup).not.toHaveBeenCalled()
  })
  it('is missing when the credential is gone from both scopes', () => {
    state.settings.aiFunctionsCredentialId = 'credential'
    state.lookup.mockReturnValue(undefined)
    expect(aiFunctions.describeBackend()).toEqual({ runsOn: 'runtime', reason: 'missing' })
  })
  it.each([
    ['disabled', () => { state.provider.enabled = false }],
    ['unsupported', () => { state.provider.unsupported = true }],
    ['keyless where a key is required', () => { state.provider.apiKeyEncrypted = null }],
    ['an unknown provider type', () => { state.providerType = () => false }]
  ])('is inactive when the credential is %s', (_label, arrange) => {
    state.settings.aiFunctionsCredentialId = 'credential'
    arrange()
    expect(aiFunctions.describeBackend()).toEqual({ runsOn: 'runtime', reason: 'inactive' })
    expect(aiFunctions.resolveBackend('profile')).toEqual({ kind: 'runtime', userId: 'profile' })
  })
  it('is no_model when an active credential names no model anywhere — and resolveBackend agrees', () => {
    state.settings.aiFunctionsCredentialId = 'credential'
    state.provider.defaultModelId = null
    state.provider.availableModels = []
    expect(aiFunctions.describeBackend()).toEqual({ runsOn: 'runtime', reason: 'no_model' })
    expectNoSideEffects()
    expect(aiFunctions.resolveBackend('profile')).toEqual({ kind: 'runtime', userId: 'profile' })
  })
  it('names the credential and the model main will use, in resolveBackend order, without building an adapter', () => {
    state.settings = { aiFunctionsCredentialId: 'credential', aiFunctionsModelId: 'not-in-any-list' }
    expect(aiFunctions.describeBackend()).toEqual({ runsOn: 'credential', credentialId: 'credential', credentialName: 'Work key', modelId: 'not-in-any-list' })
    state.settings.aiFunctionsModelId = ''
    expect(aiFunctions.describeBackend()).toMatchObject({ modelId: 'default-model' })
    state.provider.defaultModelId = null
    state.provider.availableModels = ['first-listed']
    expect(aiFunctions.describeBackend()).toMatchObject({ modelId: 'first-listed' })
    expect(aiFunctions.resolveBackend('profile')).toMatchObject({ kind: 'adapter', modelId: 'first-listed' })
    state.createAdapter.mockClear()
    state.decrypt.mockClear()
    aiFunctions.describeBackend()
    expectNoSideEffects()
  })
  it('does not touch the warn-once state', () => {
    state.settings.aiFunctionsCredentialId = 'describe-only'
    state.lookup.mockReturnValue(undefined)
    state.warn.mockClear()
    aiFunctions.describeBackend()
    expect(state.warn).not.toHaveBeenCalled()
    aiFunctions.resolveBackend('profile')
    expect(state.warn).toHaveBeenCalledTimes(1)
  })
})
