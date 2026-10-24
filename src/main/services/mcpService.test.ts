import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * `mcpService.upsert` and the directory ref: a connector created from an MCP
 * registry entry in Settings → MCP records that entry (`registry_ref`), so
 * the agent's addon picker shows it once; an update never passes one, so the
 * ref a provider was made from never moves.
 */

const upserted = (_userId: string, input: { id?: string }) => ({
  id: input.id ?? 'new',
  created: !input.id,
  row: { id: input.id ?? 'new', userId: 'u', name: 'n', transportType: 'streamable-http', enabled: false, authType: 'oauth' }
})
const repo = vi.hoisted(() => ({ upsert: vi.fn(), getOwned: vi.fn((): unknown => undefined), list: vi.fn((): unknown[] => []), delete: vi.fn() }))
vi.mock('../db/mcpProviders', () => ({ mcpProviderRepo: repo }))
vi.mock('../db/chatModes', () => ({ chatModeRepo: { stripMcpProviderId: vi.fn() } }))
const manager = vi.hoisted(() => ({ connecting: vi.fn((_id: string): Promise<unknown> | undefined => undefined) }))
vi.mock('../mcp/manager', () => ({
  mcpManager: { getConnection: () => undefined, connecting: manager.connecting, connect: vi.fn(), disconnect: vi.fn(async () => undefined), needsUser: () => false }
}))
vi.mock('../mcp/config', () => ({ mcpRowToConfig: (row: unknown) => row }))
vi.mock('../security/keystore', () => ({ encryptApiKey: (value: string) => Buffer.from(value), decryptApiKey: (value: Buffer) => value.toString('utf8') }))

const policy = vi.hoisted(() => ({ externalDirectories: true, customMcp: true, stdioMcp: true }))
vi.mock('./addonDirectory/policy', () => ({ addonPolicies: { get: () => ({ ...policy, pluginHooks: true }) } }))

const { mcpService, MANAGED_PROVIDER_DELETE_REFUSED, CUSTOM_MCP_REFUSED, EXTERNAL_DIRECTORY_REFUSED, STDIO_MCP_REFUSED, managedRefusalOf } = await import('./mcpService')

const REF = { source: 'mcp-registry:cinna-official', id: 'granola' }
const BASE = { name: 'Granola', transportType: 'streamable-http', url: 'https://g.example/mcp', enabled: false }

beforeEach(() => {
  repo.upsert.mockReset()
  repo.upsert.mockImplementation(upserted)
})

describe('mcpService.upsert registryRef', () => {
  it('writes the registry ref of a new connector', async () => {
    await mcpService.upsert('u', { ...BASE, registryRef: REF })
    expect(repo.upsert).toHaveBeenCalledWith('u', expect.objectContaining({ registryRef: REF }))
  })

  it('never passes one on an update, nor for a hand-made connector', async () => {
    await mcpService.upsert('u', { ...BASE, id: 'm1', registryRef: REF })
    expect(repo.upsert.mock.calls[0][1]).not.toHaveProperty('registryRef')
    await mcpService.upsert('u', BASE)
    expect(repo.upsert.mock.calls[1][1]).not.toHaveProperty('registryRef')
  })
})

describe('mcpService and a plugin’s provider', () => {
  const managed = {
    id: 'm1',
    userId: 'u',
    name: 'carbone',
    transportType: 'stdio',
    command: 'node',
    // The cache path under ~/Library/Application Support holds a space: one argument, not two.
    args: ['/Users/me/Library/Application Support/cinna/marketplace-plugins/x/carbone/server.mjs', '--port', '0'],
    url: null,
    env: { API_KEY: '${API_KEY}', MODE: 'fast' },
    enabled: true,
    authType: 'oauth',
    managedBy: 'plugin:3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f@' + 'a'.repeat(64),
    managedSpec: { root: '/Users/me/Library/Application Support/cinna/marketplace-plugins/x/carbone', slots: ['API_KEY'] },
    envSecretEncrypted: null as Buffer | null,
    bearerTokenEncrypted: null,
    createdAt: new Date(0)
  }
  const same = { id: 'm1', name: 'carbone', transportType: 'stdio', command: 'node', args: [...managed.args] }

  beforeEach(() => {
    managed.envSecretEncrypted = null
    repo.getOwned.mockImplementation(() => managed)
  })

  it('saves from the Settings form: args compared as parsed, the typed value stored encrypted, the plugin’s env kept', async () => {
    await mcpService.upsert('u', { ...same, env: { API_KEY: 'sk-1', MODE: 'tampered', EXTRA: 'x' }, enabled: false })
    const written = repo.upsert.mock.calls[0][1]
    expect(written).toMatchObject({ command: 'node', args: managed.args, env: managed.env, enabled: false })
    expect(written.envSecretEncrypted).toBeInstanceOf(Buffer)
    expect(JSON.parse(String(written.envSecretEncrypted))).toEqual({ API_KEY: 'sk-1' })
  })

  it('an empty value sent back (the renderer never had the stored one) keeps it', async () => {
    managed.envSecretEncrypted = Buffer.from(JSON.stringify({ API_KEY: 'sk-old' }))
    await mcpService.upsert('u', { ...same, env: { API_KEY: '' } })
    expect(repo.upsert.mock.calls[0][1]).not.toHaveProperty('envSecretEncrypted')
  })

  it('refuses any change to what the plugin owns, and writes nothing', async () => {
    for (const change of [
      { name: 'renamed' },
      { command: 'python' },
      { args: ['/elsewhere.mjs'] },
      // What the old card sent: the path split on its space.
      { args: managed.args.join(' ').split(/\s+/) },
      { transportType: 'streamable-http', url: 'https://x.example/mcp' },
      { authType: 'bearer' as const }
    ]) {
      await expect(mcpService.upsert('u', { ...same, env: { API_KEY: '' }, ...change })).rejects.toMatchObject({ code: 'managed_provider' })
    }
    expect(repo.upsert).not.toHaveBeenCalled()
  })

  it('names the plugin it comes with, from the cached folder, else the folder’s name', () => {
    repo.list.mockImplementation(() => [managed])
    expect(mcpService.list('u')[0].managedByTitle).toBe('carbone')
    expect(mcpService.list('u')[0].envSlots).toEqual([{ name: 'API_KEY', hasValue: false }])
  })

  it('says when a connect is in flight, which its status (disconnected meanwhile) does not', () => {
    repo.list.mockReturnValue([managed])
    expect(mcpService.list('u')[0].connecting).toBeUndefined()
    manager.connecting.mockImplementation((id: string) => (id === 'm1' ? new Promise(() => {}) : undefined))
    expect(mcpService.list('u')[0]).toMatchObject({ status: 'disconnected', connecting: true })
    manager.connecting.mockReset()
  })

  it('shows the renderer the names to fill in and whether each has a value — never a value', () => {
    managed.envSecretEncrypted = Buffer.from(JSON.stringify({ API_KEY: 'sk-secret' }))
    repo.list.mockReturnValue([managed])
    const [dto] = mcpService.list('u')
    expect(dto.env).toEqual({ API_KEY: '' })
    expect(dto.envSlots).toEqual([{ name: 'API_KEY', hasValue: true }])
    expect(JSON.stringify(dto)).not.toContain('sk-secret')
  })

  it('refuses a delete as data: the connector goes with its plugin', async () => {
    expect(await mcpService.delete('u', 'm1')).toEqual({ ok: false, code: 'managed', message: MANAGED_PROVIDER_DELETE_REFUSED })
    expect(repo.delete).not.toHaveBeenCalled()
  })
})

describe('mcpService and the admin’s custom_mcp policy', () => {
  afterEach(() => {
    policy.customMcp = true
  })

  it('refuses a new connector of the user’s own as data while the admin forbids them, and writes nothing', async () => {
    policy.customMcp = false
    const err = await mcpService.upsert('u', BASE).catch((e: unknown) => e)
    expect(managedRefusalOf(err)).toEqual({ ok: false, code: 'policy', message: CUSTOM_MCP_REFUSED })
    expect(repo.upsert).not.toHaveBeenCalled()
  })

  it('still creates one from a directory entry, and edits an existing one', async () => {
    policy.customMcp = false
    repo.getOwned.mockImplementation(() => undefined)
    await mcpService.upsert('u', { ...BASE, registryRef: REF })
    await mcpService.upsert('u', { ...BASE, id: 'm1' })
    expect(repo.upsert).toHaveBeenCalledTimes(2)
  })
})

describe('mcpService and a local connector made from a directory entry', () => {
  const ref = { source: 'core-mcp-directory', id: 'fs' }
  const row = (env: Record<string, string>, secrets: Record<string, string> | null) => ({
    id: 'd1',
    userId: 'u',
    name: 'File System',
    transportType: 'stdio',
    command: 'npx',
    args: ['-y', '@mcp/fs@1.0'],
    url: null,
    env,
    enabled: true,
    authType: 'oauth',
    managedBy: null,
    managedSpec: null,
    registryRef: ref,
    envSecretEncrypted: secrets ? Buffer.from(JSON.stringify(secrets)) : null,
    bearerTokenEncrypted: null,
    authTokensEncrypted: null,
    clientInfo: null,
    createdAt: new Date(0)
  })
  const INPUT = { id: 'd1', name: 'File System', transportType: 'stdio', command: 'npx', args: ['-y', '@mcp/fs@1.0'] }

  it('stores what the user types encrypted, the names only in the plain env; an empty value keeps the stored one', async () => {
    repo.getOwned.mockImplementation(() => row({ ROOT: '', TOKEN: '' }, { TOKEN: 'sk-old' }))
    await mcpService.upsert('u', { ...INPUT, env: { ROOT: '/srv', TOKEN: '' } })
    const written = repo.upsert.mock.calls[0][1]
    expect(written.env).toEqual({ ROOT: '', TOKEN: '' })
    expect(JSON.parse(String(written.envSecretEncrypted))).toEqual({ ROOT: '/srv', TOKEN: 'sk-old' })
  })

  it('shows the renderer names and whether each has a value, never a value', () => {
    repo.list.mockImplementation(() => [row({ ROOT: '', TOKEN: '' }, { TOKEN: 'sk-1' })])
    const [dto] = mcpService.list('u')
    expect(dto.env).toEqual({ ROOT: '', TOKEN: '' })
    expect(dto).not.toHaveProperty('envSecretEncrypted')
    expect(dto.envSlots).toEqual([
      { name: 'ROOT', hasValue: false },
      { name: 'TOKEN', hasValue: true }
    ])
    expect(JSON.stringify(dto)).not.toContain('sk-1')
    // Nothing plain to move: no write on a read.
    expect(repo.upsert).not.toHaveBeenCalled()
  })

  it('moves values stored in the plain env before they were encrypted on the first read', () => {
    repo.list.mockImplementation(() => [row({ ROOT: '/srv', TOKEN: 'sk-plain' }, null)])
    repo.upsert.mockImplementation((_userId: string, input: { env: Record<string, string>; envSecretEncrypted: Buffer }) => ({
      id: 'd1',
      created: false,
      row: { ...row(input.env, JSON.parse(String(input.envSecretEncrypted)) as Record<string, string>) }
    }))
    const [dto] = mcpService.list('u')
    const written = repo.upsert.mock.calls[0][1]
    expect(written.env).toEqual({ ROOT: '', TOKEN: '' })
    expect(JSON.parse(String(written.envSecretEncrypted))).toEqual({ ROOT: '/srv', TOKEN: 'sk-plain' })
    expect(JSON.stringify(dto)).not.toContain('sk-plain')
    expect(dto.envSlots?.every((slot) => slot.hasValue)).toBe(true)
  })

  it('never shows a plain value, even when moving it fails', () => {
    repo.list.mockImplementation(() => [row({ ROOT: '/srv', TOKEN: 'sk-plain' }, null)])
    repo.upsert.mockImplementation(() => {
      throw new Error('database is locked')
    })
    const [dto] = mcpService.list('u')
    expect(dto.env).toEqual({ ROOT: '', TOKEN: '' })
    expect(JSON.stringify(dto)).not.toContain('sk-plain')
    expect(JSON.stringify(dto)).not.toContain('/srv')
  })
})

describe('mcpService.upsert and the admin’s policy on where a new connector comes from', () => {
  afterEach(() => {
    Object.assign(policy, { externalDirectories: true, customMcp: true, stdioMcp: true })
    repo.getOwned.mockImplementation(() => undefined)
  })

  it('refuses a public registry’s connector as data while external directories are off, and writes nothing', async () => {
    policy.externalDirectories = false
    const err = await mcpService.upsert('u', { ...BASE, registryRef: REF }).catch((e: unknown) => e)
    expect(managedRefusalOf(err)).toEqual({ ok: false, code: 'policy', message: EXTERNAL_DIRECTORY_REFUSED })
    expect(repo.upsert).not.toHaveBeenCalled()
  })

  it('allows a core MCP directory connector with external directories and custom connectors off', async () => {
    policy.externalDirectories = false
    policy.customMcp = false
    await mcpService.upsert('u', { ...BASE, registryRef: { source: 'core-mcp-directory', id: 'x' } })
    expect(repo.upsert).toHaveBeenCalledTimes(1)
  })

  it('checks a ref of any other source as the user’s own connector', async () => {
    policy.customMcp = false
    const err = await mcpService.upsert('u', { ...BASE, registryRef: { source: 'made-up', id: 'x' } }).catch((e: unknown) => e)
    expect(managedRefusalOf(err)).toEqual({ ok: false, code: 'policy', message: CUSTOM_MCP_REFUSED })
  })

  it('refuses a new local connector while local servers are off, from a directory too, but edits a hand-made one', async () => {
    policy.stdioMcp = false
    const local = { name: 'L', transportType: 'stdio', command: 'node', args: ['s.js'] }
    for (const input of [local, { ...local, registryRef: { source: 'core-mcp-directory', id: 'x' } }]) {
      const err = await mcpService.upsert('u', input).catch((e: unknown) => e)
      expect(managedRefusalOf(err)).toEqual({ ok: false, code: 'policy', message: STDIO_MCP_REFUSED })
    }
    repo.getOwned.mockImplementation(() => ({ id: 'l1', transportType: 'stdio', managedBy: null, registryRef: null, env: null, envSecretEncrypted: null }))
    await mcpService.upsert('u', { ...local, id: 'l1' })
    expect(repo.upsert).toHaveBeenCalledTimes(1)
  })

  it('refuses turning a remote connector into a local one while local servers are off', async () => {
    policy.stdioMcp = false
    repo.getOwned.mockImplementation(() => ({ id: 'r1', transportType: 'streamable-http', managedBy: null, registryRef: null, env: null, envSecretEncrypted: null }))
    const err = await mcpService.upsert('u', { id: 'r1', name: 'R', transportType: 'stdio', command: 'node' }).catch((e: unknown) => e)
    expect(managedRefusalOf(err)).toEqual({ ok: false, code: 'policy', message: STDIO_MCP_REFUSED })
  })
})
