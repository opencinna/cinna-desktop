import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ disconnect: vi.fn(), register: vi.fn(), connect: vi.fn(), managed: vi.fn(), profile: 'a' }))
vi.mock('../db/llmProviders', () => ({ llmProviderRepo: { list: () => [{ id: 'llm', type: 'ollama', enabled: true, name: 'Local', apiKeyEncrypted: null }] } }))
const mcpRows = vi.hoisted(() => ({ rows: [{ id: 'mcp', enabled: true }] as Array<Record<string, unknown>> }))
const starts = vi.hoisted(() => vi.fn(async (row: { id: string }) => row.id === 'ready'))
vi.mock('../db/mcpProviders', () => ({ mcpProviderRepo: { list: () => mcpRows.rows } }))
const blocks = vi.hoisted(() => vi.fn(async (row: { id: string }, _launch?: { blockedReason?: string }): Promise<string | null> => (row.id === 'policy-blocked' ? 'Blocked by your admin' : null)))
vi.mock('../services/marketplacePluginService', () => ({ marketplacePluginService: { startsUnattended: starts, launchBlockOf: blocks } }))
vi.mock('../llm/registry', () => ({ clearAllAdapters() {}, registerAdapter: state.register }))
vi.mock('../llm/factory', () => ({ createAdapter: () => ({}) }))
vi.mock('../security/keystore', () => ({ decryptApiKey: async () => '' }))
vi.mock('../mcp/manager', () => ({ mcpManager: { disconnectAll: state.disconnect, connect: state.connect } }))
const toConfig = vi.hoisted(() => ({ map: (value: unknown): unknown => value }))
vi.mock('../mcp/config', () => ({ mcpRowToConfig: async (value: unknown) => toConfig.map(value) }))
const attached = vi.hoisted(() => ({ ids: new Set<string>() }))
vi.mock('../db/agentMcp', () => ({ agentMcpRepo: { agentIdsFor: (id: string) => (attached.ids.has(id) ? ['agent'] : []) } }))
vi.mock('../mcp/managed', () => ({
  missingEnvOf: async (row: { env?: Record<string, string> }) => Object.entries(row.env ?? {}).filter(([, value]) => value === '').map(([name]) => name)
}))
vi.mock('./scope', () => ({ getSettingsScopeUserId: () => 'settings', getProfileScopeUserId: () => state.profile, DEFAULT_SCOPE_USER_ID: 'settings' }))
vi.mock('../services/accountConfigService', () => ({ accountConfigService: { loadManagedAdapters: state.managed } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ error() {} }) }))
const { reloadUserProviders } = await import('./reload')

beforeEach(() => { vi.clearAllMocks(); mcpRows.rows = [{ id: 'mcp', enabled: true }]; state.profile = 'a'; state.disconnect.mockResolvedValue(undefined); state.connect.mockResolvedValue(undefined) })
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
  expect(state.managed).toHaveBeenCalledWith('a', expect.any(Function))
  expect(state.connect).toHaveBeenCalledTimes(1)
})
it('starts a plugin’s connector only when it can run unattended (an agent has it, its values given, not blocked)', async () => {
  mcpRows.rows = [
    { id: 'mcp', enabled: true },
    { id: 'ready', enabled: true, managedBy: 'plugin:e@s' },
    { id: 'needs-setup', enabled: true, managedBy: 'plugin:e@s' }
  ]
  await reloadUserProviders(() => true)
  await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(2))
  await new Promise((done) => setTimeout(done, 0))
  expect(state.connect.mock.calls.map(([config]) => (config as { id: string }).id).sort()).toEqual(['mcp', 'ready'])
})
it('starts a connector made from a directory entry once its settings are filled in, with or without an agent (Settings → MCP registry connectors serve chats)', async () => {
  const ref = { source: 'core-mcp-directory', id: 'x' }
  mcpRows.rows = [
    { id: 'mcp', enabled: true },
    { id: 'dir-ready', enabled: true, registryRef: ref, env: { TOKEN: '' } },
    { id: 'dir-empty', enabled: true, registryRef: ref, env: { TOKEN: '' } },
    { id: 'dir-unused', enabled: true, registryRef: ref }
  ]
  attached.ids = new Set(['dir-ready', 'dir-empty'])
  // `dir-ready`'s value is stored (the mock reads `''` as missing): give it one.
  ;(mcpRows.rows[1] as { env: Record<string, string> }).env = { TOKEN: 'set' }
  await reloadUserProviders(() => true)
  expect(state.connect.mock.calls.map(([config]) => (config as { id: string }).id).sort()).toEqual(['dir-ready', 'dir-unused', 'mcp'])
})
it('hands a plugin’s connector held back only by a launch block to the manager, which refuses it with the sentence its card reads', async () => {
  mcpRows.rows = [
    { id: 'ready', enabled: true, managedBy: 'plugin:e@s' },
    { id: 'policy-blocked', enabled: true, managedBy: 'plugin:e@s' },
    { id: 'needs-setup', enabled: true, managedBy: 'plugin:e@s' }
  ]
  await reloadUserProviders(() => true)
  await vi.waitFor(() => expect(state.connect).toHaveBeenCalledTimes(2))
  await new Promise((done) => setTimeout(done, 0))
  expect(state.connect.mock.calls.map(([config]) => (config as { id: string }).id).sort()).toEqual(['policy-blocked', 'ready'])
})
it('takes a plugin connector’s block from the config it connects with, so a policy that changes in between never starts it unblocked', async () => {
  // The policy forbids local servers when the config is built, and allows them one microtask later.
  let forbidden = true
  toConfig.map = (value) => {
    const config = { ...(value as object), ...(forbidden ? { blockedReason: 'Blocked by your admin' } : {}) }
    queueMicrotask(() => { forbidden = false })
    return config
  }
  // Like the real one: the block is the config's when it is given one; a fresh policy read otherwise.
  blocks.mockImplementationOnce(async (_row, launch) => (launch ? (launch.blockedReason ?? null) : forbidden ? 'Blocked by your admin' : null))
  mcpRows.rows = [{ id: 'flip', enabled: true, managedBy: 'plugin:e@s' }]
  try {
    await reloadUserProviders(() => true)
    await vi.waitFor(() => expect(blocks).toHaveBeenCalledTimes(1))
    await new Promise((done) => setTimeout(done, 0))
    // Held back by startsUnattended: connected only to be refused, with the block its config carries.
    for (const [config] of state.connect.mock.calls) expect(config).toMatchObject({ blockedReason: 'Blocked by your admin' })
    expect(state.connect).toHaveBeenCalledTimes(1)
  } finally {
    toConfig.map = (value) => value
  }
})
