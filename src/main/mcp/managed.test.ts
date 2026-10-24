import { describe, expect, it, vi } from 'vitest'

/**
 * A managed (plugin) provider at launch: `${VAR}`s filled from the user's
 * encrypted values and the plugin's own env, declared headers resolved, the
 * managed uv's `UV_*` environment plus a writable project environment under
 * a managed-uv command, a launch refused when the policy forbids it or the
 * cached tree changed, and a provider no plugin owns left exactly as it is.
 */

const policy = vi.hoisted(() => ({ stdioMcp: true }))
const tree = vi.hoisted(() => ({ ok: true }))

vi.mock('../localdev/toolchain', () => ({
  managedUvLayout: () => ({ uvBin: '/ud/localdev/uv/uv', uvxBin: '/ud/localdev/uv/uvx', env: { UV_CACHE_DIR: '/ud/localdev/uv-cache', UV_PYTHON_INSTALL_DIR: '/ud/localdev/python' } })
}))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: { getPath: () => '/ud', keystore: { isEncryptionAvailable: () => false } } }))
vi.mock('../services/addonDirectory/policy', () => ({ addonPolicies: { get: () => ({ stdioMcp: policy.stdioMcp, pluginHooks: true }) } }))
vi.mock('../services/marketplacePluginCache', () => ({
  verifyPluginTree: () => tree.ok,
  PLUGIN_TREE_MODIFIED_SENTENCE: 'The cached copy was changed on disk — Update to restore it'
}))
vi.mock('../services/stdioRuntimes', () => ({ STDIO_RUNTIME_TEXT: { policy: 'Blocked by your admin' } }))

const {
  encryptManagedSecrets,
  fillPlaceholders,
  managedSlotStates,
  missingManagedEnv,
  pluginManagedBy,
  pluginOfManagedBy,
  resolveManagedLaunch,
  snapshotKeyOfManagedBy
} = await import('./managed')

const ENTRY = '3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f'
const SHA = 'a'.repeat(64)
const OWNER = pluginManagedBy(ENTRY, SHA)

const base = {
  id: 'm1',
  userId: 'u',
  configRevision: 0,
  name: 'carbone',
  transportType: 'stdio' as const,
  enabled: true,
  authType: 'oauth' as const
}

const owned = (values: Record<string, string>, spec: Partial<{ slots: string[]; headers: Record<string, string>; bearer: boolean }> = {}) => ({
  managedBy: OWNER,
  managedSpec: { root: '/cache/carbone', slots: Object.keys(values), ...spec },
  envSecretEncrypted: encryptManagedSecrets(values)
})

describe('managed MCP providers', () => {
  it('fills placeholders from the user’s values and the plugin’s env at launch', () => {
    const config = resolveManagedLaunch(
      { ...base, command: 'node', args: ['/c/s.mjs', '--key=${API_KEY}', '${UNKNOWN}'], env: { API_KEY: '${API_KEY}', AUTH: 'Bearer ${API_KEY}', MODE: 'fast' } },
      owned({ API_KEY: 'sk-1' })
    )
    expect(config.args).toEqual(['/c/s.mjs', '--key=sk-1', '${UNKNOWN}'])
    expect(config.env).toEqual({ API_KEY: 'sk-1', AUTH: 'Bearer sk-1', MODE: 'fast' })
    expect(config.blockedReason).toBeUndefined()
  })

  it('hands a managed-uv command uv’s environment and its own writable project environment', () => {
    const config = resolveManagedLaunch({ ...base, command: '/ud/localdev/uv/uv', args: ['run', '--frozen', '--directory', '/cache/carbone', 'carbone'], env: {} }, owned({}))
    expect(config.env).toEqual({
      UV_CACHE_DIR: '/ud/localdev/uv-cache',
      UV_PYTHON_INSTALL_DIR: '/ud/localdev/python',
      UV_PROJECT_ENVIRONMENT: `/ud/plugin-envs/${ENTRY}/${SHA}/carbone`
    })
    expect(resolveManagedLaunch({ ...base, command: 'node', args: [] }, owned({})).env).toEqual({})
  })

  it('resolves an HTTP server’s declared headers', () => {
    const config = resolveManagedLaunch(
      { ...base, transportType: 'streamable-http', url: 'https://api.example/mcp', authType: 'bearer' },
      owned({ API_KEY: 'sk-h' }, { headers: { 'X-Api-Key': '${API_KEY}', 'X-Org': 'acme' } })
    )
    expect(config.headers).toEqual({ 'X-Api-Key': 'sk-h', 'X-Org': 'acme' })
  })

  it('refuses to launch a local server whose cached files changed, or when the policy forbids local servers', () => {
    tree.ok = false
    expect(resolveManagedLaunch({ ...base, command: 'node', args: [] }, owned({})).blockedReason).toBe('The cached copy was changed on disk — Update to restore it')
    tree.ok = true
    policy.stdioMcp = false
    expect(resolveManagedLaunch({ ...base, command: 'node', args: [] }, owned({})).blockedReason).toBe('Blocked by your admin')
    policy.stdioMcp = true
  })

  it('leaves a provider no plugin owns as it is', () => {
    const config = { ...base, command: 'node', args: ['${X}'], env: { X: '1' } }
    expect(resolveManagedLaunch(config, { managedBy: null })).toBe(config)
  })

  it('reads the owner, its snapshot and what is still to fill in — names and booleans only', () => {
    expect(pluginManagedBy(' ABC ', 'F00')).toBe('plugin:abc@f00')
    expect(pluginOfManagedBy('plugin:abc@f00')).toEqual({ entryUuid: 'abc', sha: 'f00' })
    expect(pluginOfManagedBy(null)).toBeNull()
    expect(snapshotKeyOfManagedBy(OWNER)).toBe(`${ENTRY}/${SHA}`)
    const row = { ...owned({ A: 'x' }), managedSpec: { root: '/c', slots: ['A', 'B'] } }
    expect(missingManagedEnv(row)).toEqual(['B'])
    expect(managedSlotStates(row)).toEqual([
      { name: 'A', hasValue: true },
      { name: 'B', hasValue: false }
    ])
    expect(missingManagedEnv({ managedBy: null, managedSpec: { root: '/c', slots: ['A'] } })).toEqual([])
    expect(fillPlaceholders('${A}-${B}', { A: '1' })).toBe('1-${B}')
  })
})
