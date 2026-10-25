import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../../db/users', () => ({ userRepo: { get: () => undefined } }))
vi.mock('../../db/addonPolicies', () => ({ addonPolicyRepo: { get: () => null, set: () => undefined } }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => 'profile' }))
vi.mock('../../db/mcpProviders', () => ({ mcpProviderRepo: { list: () => [] } }))
vi.mock('../../mcp/manager', () => ({ mcpManager: { getConnection: () => undefined, disconnect: async () => undefined } }))
vi.mock('../../mcp/config', () => ({ mcpRowToConfig: (row: unknown) => row }))
vi.mock('../../mcp/managed', () => ({
  missingEnvOf: (row: { env?: Record<string, string> | null }) => Object.entries(row.env ?? {}).filter(([, value]) => value === '').map(([name]) => name)
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ info() {}, warn() {} }) }))

const { addonPolicies } = await import('./policy')
const { installAddonPolicyFollow, gatedBy, resumeAllowed } = await import('./policyFollow')

/**
 * The admin turns local servers off: a plugin's and a directory's running
 * local servers stop; a hand-made local connector and every remote one keep
 * running, and nothing is deleted. Only the active account's change counts.
 */

const ALL = { externalDirectories: true, customMcp: true, pluginHooks: true, stdioMcp: true }
const SCOPE = '__default__'
const rows = [
  { id: 'plugin-local', transportType: 'stdio', managedBy: 'plugin:e@s', registryRef: null },
  { id: 'dir-local', transportType: 'stdio', managedBy: null, registryRef: { source: 'core-mcp-directory', id: 'fs' } },
  { id: 'hand-made', transportType: 'stdio', managedBy: null, registryRef: null },
  { id: 'dir-remote', transportType: 'streamable-http', managedBy: null, registryRef: { source: 'core-mcp-directory', id: 'gh' } },
  { id: 'plugin-stopped', transportType: 'stdio', managedBy: 'plugin:e@s', registryRef: null }
]

let uninstall: (() => void) | null = null
afterEach(() => {
  uninstall?.()
  addonPolicies._reset()
})

function follow() {
  const disconnect = vi.fn(async (_id: string) => undefined)
  uninstall = installAddonPolicyFollow({
    rows: () => rows as never,
    running: (id) => id !== 'plugin-stopped',
    error: () => undefined,
    disconnect,
    startsUnattended: async () => true,
    connect: async () => undefined
  })
  return disconnect
}

describe('installAddonPolicyFollow', () => {
  it('stops a plugin’s and a directory’s running local servers when local servers are turned off, and never a hand-made one', async () => {
    let account: string | null = 'p1@https://core'
    addonPolicies._configure({ account: () => account, load: () => null, save: () => undefined })
    const disconnect = follow()
    addonPolicies.set(SCOPE, { ...ALL, pluginHooks: false })
    await Promise.resolve()
    expect(disconnect).not.toHaveBeenCalled()

    addonPolicies.set(SCOPE, { ...ALL, pluginHooks: false, stdioMcp: false })
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(2))
    expect(disconnect.mock.calls.map(([id]) => id).sort()).toEqual(['dir-local', 'plugin-local'])

    // The same policy again changes nothing; a policy filed for another account than the active one stops nothing.
    disconnect.mockClear()
    addonPolicies.set(SCOPE, { ...ALL, pluginHooks: false, stdioMcp: false })
    addonPolicies.set(SCOPE, ALL, 'p2@https://other')
    account = 'p2@https://other'
    addonPolicies.set(SCOPE, { ...ALL, stdioMcp: false }, 'p1@https://core')
    await Promise.resolve()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('gates nothing when local servers stay allowed, or were already off', () => {
    expect(gatedBy(rows, ALL, { ...ALL, customMcp: false, externalDirectories: false })).toEqual([])
    expect(gatedBy(rows, { ...ALL, stdioMcp: false }, { ...ALL, stdioMcp: false })).toEqual([])
    expect(gatedBy(rows, ALL, { ...ALL, stdioMcp: false })).toEqual(['plugin-local', 'dir-local', 'plugin-stopped'])
  })
})

describe('resumeAllowed', () => {
  const POLICY = 'Blocked by your admin'
  const refusedRows = [
    { id: 'plugin-runs', enabled: true, transportType: 'stdio', managedBy: 'plugin:e@s', registryRef: null },
    { id: 'plugin-needs-node', enabled: true, transportType: 'stdio', managedBy: 'plugin:e@s', registryRef: null },
    { id: 'dir-filled', enabled: true, transportType: 'stdio', managedBy: null, registryRef: { source: 'core-mcp-directory', id: 'fs' }, env: { ROOT: '/tmp' } },
    { id: 'dir-empty', enabled: true, transportType: 'stdio', managedBy: null, registryRef: { source: 'core-mcp-directory', id: 'fs' }, env: { ROOT: '' } },
    { id: 'dir-off', enabled: false, transportType: 'stdio', managedBy: null, registryRef: { source: 'core-mcp-directory', id: 'fs' } },
    { id: 'other-error', enabled: true, transportType: 'stdio', managedBy: 'plugin:e@s', registryRef: null },
    { id: 'disconnected', enabled: true, transportType: 'stdio', managedBy: 'plugin:e@s', registryRef: null }
  ]
  const errors: Record<string, string> = {
    'plugin-runs': POLICY, 'plugin-needs-node': POLICY, 'dir-filled': POLICY, 'dir-empty': POLICY, 'dir-off': POLICY, 'other-error': 'spawn node ENOENT'
  }
  function deps() {
    return {
      rows: () => refusedRows as never,
      running: () => true,
      error: (id: string) => errors[id],
      disconnect: vi.fn(async (_id: string) => undefined),
      startsUnattended: vi.fn(async (row: { id: string }) => row.id === 'plugin-runs'),
      connect: vi.fn(async (_row: { id: string }) => undefined)
    }
  }

  it('clears every connection the policy refused once local servers are allowed again, and starts each as app start would', async () => {
    let account: string | null = 'p1@https://core'
    addonPolicies._configure({ account: () => account, load: () => null, save: () => undefined })
    const d = deps()
    uninstall = installAddonPolicyFollow(d)
    addonPolicies.set(SCOPE, { ...ALL, stdioMcp: false })
    // Turning them off stopped what ran (the first describe); from here on, only what turning them on does.
    await vi.waitFor(() => expect(d.disconnect).toHaveBeenCalled())
    d.disconnect.mockClear()
    expect(d.connect).not.toHaveBeenCalled()
    addonPolicies.set(SCOPE, ALL)
    await vi.waitFor(() => expect(d.connect).toHaveBeenCalledTimes(2))
    // Cleared: every row whose error is the policy's sentence, whether or not it starts; never another failure, nor a row with none.
    expect(d.disconnect.mock.calls.map(([id]) => id).sort()).toEqual(['dir-empty', 'dir-filled', 'dir-off', 'plugin-needs-node', 'plugin-runs'])
    // Started: the plugin's that may run unattended, the directory's whose settings are filled in.
    expect(d.connect.mock.calls.map(([row]) => row.id).sort()).toEqual(['dir-filled', 'plugin-runs'])
    account = null
  })

  it('does nothing while local servers stay forbidden, or were allowed already', async () => {
    const d = deps()
    expect(await resumeAllowed(SCOPE, ALL, ALL, d)).toEqual([])
    expect(await resumeAllowed(SCOPE, { ...ALL, stdioMcp: false }, { ...ALL, stdioMcp: false, customMcp: false }, d)).toEqual([])
    expect(await resumeAllowed(SCOPE, ALL, { ...ALL, stdioMcp: false }, d)).toEqual([])
    expect(d.disconnect).not.toHaveBeenCalled()
    expect(d.connect).not.toHaveBeenCalled()
  })
})
