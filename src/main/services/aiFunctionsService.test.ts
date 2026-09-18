import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMAdapter } from '../llm/types'

const state = vi.hoisted(() => ({
  settings: { aiFunctionsCredentialId: '', aiFunctionsModelId: '' },
  provider: { id: 'credential', type: 'openai', enabled: true, unsupported: false, apiKeyEncrypted: Buffer.from('encrypted'), defaultModelId: 'default-model', availableModels: [] as string[], baseUrl: null },
  stream: vi.fn(), runtime: vi.fn(), lookup: vi.fn()
}))
vi.mock('../db/appSettings', () => ({ appSettingsRepo: { get: (key: keyof typeof state.settings) => state.settings[key] } }))
vi.mock('../db/llmProviders', () => ({ llmProviderRepo: { getOwned: (...args: unknown[]) => state.lookup(...args) } }))
vi.mock('../security/keystore', () => ({ decryptApiKey: () => 'decrypted' }))
vi.mock('../auth/scope', () => ({ getManagedResourceScopes: () => ['default', 'profile'] }))
vi.mock('../llm/factory', () => ({ isProviderType: () => true, createAdapter: () => ({ providerType: 'openai', stream: state.stream }) }))
vi.mock('./aiFunctionRuntimeService', () => ({ runAiFunctionOnRuntime: (...args: unknown[]) => state.runtime(...args) }))

import { aiFunctions, AiFunctionError, AI_FUNCTION_TIMEOUT_MS } from './aiFunctionsService'

beforeEach(() => {
  state.settings = { aiFunctionsCredentialId: '', aiFunctionsModelId: '' }
  state.provider.enabled = true
  state.provider.unsupported = false
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
  it('refuses a configured unavailable credential rather than silently charging another runtime', () => {
    state.settings.aiFunctionsCredentialId = 'credential'
    state.provider.enabled = false
    expect(() => aiFunctions.resolveBackend('profile')).toThrow(AiFunctionError)
    state.provider.enabled = true
    state.provider.unsupported = true
    expect(() => aiFunctions.resolveBackend('profile')).toThrow(AiFunctionError)
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
