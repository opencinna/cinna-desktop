import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { LLMAdapter } from '../llm/types'

const state = vi.hoisted(() => ({ db: null as TestDatabase | null }))
vi.mock('../db/client', () => ({ getDb: () => state.db!.db, getRawSqlite: () => state.db!.sqlite }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }) }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'wrong-profile', getManagedResourceScopes: () => ['wrong-profile'] }))
const { resolveTaskModelConfig } = await import('./taskModelConfig')
const { llmProviderRepo } = await import('../db/llmProviders')
const { chatModeRepo } = await import('../db/chatModes')
const { managedOverrideRepo } = await import('../db/managedOverrides')
const { appSettingsRepo } = await import('../db/appSettings')
const { registerAdapter, clearAllAdapters } = await import('../llm/registry')
const SCOPE = { settingsUserId: '__default__', profileUserId: 'profile' }
const listModels = vi.fn(async () => [{ id: 'model-auto', name: 'Auto', providerId: 'p-local', providerType: 'ollama' }])

function mode(owner: string, suffix: string, managed: boolean, modelId: string | null = 'model-one') {
  const providerId = `p-${suffix}`
  llmProviderRepo.upsert(owner, { id: providerId, createIfMissing: true, type: 'ollama', name: suffix, enabled: true, managed })
  registerAdapter(providerId, { listModels } as unknown as LLMAdapter)
  chatModeRepo.insert(owner, { id: `mode-${suffix}`, name: suffix, providerId, modelId, managed, isDefault: true })
  return { providerId, modeId: `mode-${suffix}` }
}
beforeEach(() => { state.db = createTestDatabase(); clearAllAdapters(); vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers(); clearAllAdapters(); state.db?.close(); state.db = null })

describe('task model configuration', () => {
  it('honors captured scopes, local/account precedence and profile model overrides', async () => {
    mode('__default__', 'local', false)
    mode('profile', 'managed', true)
    mode('wrong-profile', 'wrong', true)
    managedOverrideRepo.setModel('profile', 'mode', 'mode-managed', 'chosen-managed-model')
    expect(await resolveTaskModelConfig(SCOPE)).toMatchObject({ modeId: 'mode-local', modelId: 'model-one' })
    appSettingsRepo.set('prioritizeAccountDefaults', true)
    expect(await resolveTaskModelConfig(SCOPE)).toMatchObject({ modeId: 'mode-managed', modelId: 'chosen-managed-model' })
    expect(listModels).not.toHaveBeenCalled()
  })

  it('refuses an explicitly disabled or foreign mode instead of silently changing it', async () => {
    mode('profile', 'managed', true)
    mode('wrong-profile', 'wrong', true)
    managedOverrideRepo.set('profile', 'mode', 'mode-managed', false)
    await expect(resolveTaskModelConfig(SCOPE, 'mode-managed')).rejects.toThrow('unavailable')
    await expect(resolveTaskModelConfig(SCOPE, 'mode-wrong')).rejects.toThrow('unavailable')
  })

  it('uses only the chosen provider for discovery and rechecks its identity afterward', async () => {
    mode('__default__', 'local', false, null)
    const unrelated = vi.fn(() => new Promise(() => {}))
    registerAdapter('unrelated', { listModels: unrelated } as unknown as LLMAdapter)
    expect(await resolveTaskModelConfig(SCOPE)).toMatchObject({ modelId: 'model-auto' })
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(unrelated).not.toHaveBeenCalled()
    listModels.mockImplementationOnce(async () => {
      registerAdapter('p-local', { listModels } as unknown as LLMAdapter)
      return [{ id: 'other', name: 'Other', providerId: 'p-local', providerType: 'ollama' }]
    })
    await expect(resolveTaskModelConfig(SCOPE)).rejects.toThrow('configuration changed')
  })

  it('uses managed curated candidates when no model is configured', async () => {
    mode('profile', 'managed', true, null)
    llmProviderRepo.upsert('profile', { id: 'p-managed', type: 'ollama', name: 'Managed', availableModels: ['text-embedding-x', 'chat-ready'] })
    expect(await resolveTaskModelConfig(SCOPE)).toMatchObject({ modelId: 'chat-ready' })
    expect(listModels).not.toHaveBeenCalled()
  })

  it('refuses a missing baseline tool before a chat can be created', async () => {
    mode('__default__', 'local', false)
    chatModeRepo.update('__default__', 'mode-local', { name: 'Local', providerId: 'p-local', modelId: 'model-one', mcpProviderIds: ['missing'] })
    await expect(resolveTaskModelConfig(SCOPE)).rejects.toThrow('missing tool')
  })

  it('bounds an unresponsive discovery request without querying other providers', async () => {
    vi.useFakeTimers()
    mode('__default__', 'local', false, null)
    listModels.mockImplementationOnce(() => new Promise(() => {}))
    const result = resolveTaskModelConfig(SCOPE)
    const rejected = expect(result).rejects.toThrow('model list could not be read')
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    const retry = expect(resolveTaskModelConfig(SCOPE)).rejects.toThrow('model list could not be read')
    await vi.advanceTimersByTimeAsync(10_000)
    await retry
    expect(listModels).toHaveBeenCalledTimes(1)
  })

  it('rechecks configuration again immediately before acceptance', async () => {
    mode('__default__', 'local', false)
    const config = await resolveTaskModelConfig(SCOPE)
    llmProviderRepo.upsert('__default__', { id: 'p-local', type: 'ollama', name: 'Local', enabled: false })
    expect(config.assertCurrent).toThrow('available AI credential')
  })
})
