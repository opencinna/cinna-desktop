import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ disconnect: vi.fn(), register: vi.fn(), connect: vi.fn(), managed: vi.fn(), profile: 'a' }))
vi.mock('../db/llmProviders', () => ({ llmProviderRepo: { list: () => [{ id: 'llm', type: 'ollama', enabled: true, name: 'Local', apiKeyEncrypted: null }] } }))
vi.mock('../db/mcpProviders', () => ({ mcpProviderRepo: { list: () => [{ id: 'mcp', enabled: true }] } }))
vi.mock('../llm/registry', () => ({ clearAllAdapters() {}, registerAdapter: state.register }))
vi.mock('../llm/factory', () => ({ createAdapter: () => ({}) }))
vi.mock('../security/keystore', () => ({ decryptApiKey: () => '' }))
vi.mock('../mcp/manager', () => ({ mcpManager: { disconnectAll: state.disconnect, connect: state.connect } }))
vi.mock('../mcp/config', () => ({ mcpRowToConfig: (value: unknown) => value }))
vi.mock('./scope', () => ({ getSettingsScopeUserId: () => 'settings', getProfileScopeUserId: () => state.profile, DEFAULT_SCOPE_USER_ID: 'settings' }))
vi.mock('../services/accountConfigService', () => ({ accountConfigService: { loadManagedAdapters: state.managed } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ error() {} }) }))
const { reloadUserProviders } = await import('./reload')

beforeEach(() => { vi.clearAllMocks(); state.profile = 'a'; state.disconnect.mockResolvedValue(undefined); state.connect.mockResolvedValue(undefined) })
it('does not register old profile providers after its pending disconnect is revoked', async () => {
  let finish = () => {}
  let current = true
  state.disconnect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  const pending = reloadUserProviders(() => current)
  current = false; state.profile = 'b'; finish(); await pending
  expect(state.register).not.toHaveBeenCalled()
  expect(state.managed).not.toHaveBeenCalled()
  expect(state.connect).not.toHaveBeenCalled()
})
it('loads the captured profile and shared providers after successful teardown', async () => {
  await reloadUserProviders(() => true)
  expect(state.register).toHaveBeenCalledWith('llm', {})
  expect(state.managed).toHaveBeenCalledWith('a')
  expect(state.connect).toHaveBeenCalledTimes(1)
})
