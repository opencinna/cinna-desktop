import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('../mcp/manager', () => ({
  mcpManager: { getConnection: () => undefined, connect: vi.fn(), disconnect: vi.fn(async () => undefined), needsUser: () => false }
}))
vi.mock('../mcp/config', () => ({ mcpRowToConfig: (row: unknown) => row }))
vi.mock('../security/keystore', () => ({ encryptApiKey: (value: string) => Buffer.from(value), decryptApiKey: (value: Buffer) => value.toString('utf8') }))

const { mcpService, MANAGED_PROVIDER_DELETE_REFUSED } = await import('./mcpService')

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
