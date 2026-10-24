import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../../db/users', () => ({ userRepo: { get: () => undefined } }))
vi.mock('../../db/addonPolicies', () => ({ addonPolicyRepo: { get: () => null, set: () => undefined } }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => 'profile' }))
vi.mock('../../db/mcpProviders', () => ({ mcpProviderRepo: { list: () => [] } }))
vi.mock('../../mcp/manager', () => ({ mcpManager: { getConnection: () => undefined, disconnect: async () => undefined } }))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ info() {}, warn() {} }) }))

const { addonPolicies } = await import('./policy')
const { installAddonPolicyFollow, gatedBy } = await import('./policyFollow')

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
  uninstall = installAddonPolicyFollow({ rows: () => rows, running: (id) => id !== 'plugin-stopped', disconnect })
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
