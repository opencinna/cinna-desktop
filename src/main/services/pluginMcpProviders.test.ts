import { describe, expect, it, vi } from 'vitest'

/**
 * A pinned plugin's MCP servers as managed Cinna providers: one row per
 * snapshot, created and attached on sync, shared by two agents on the same
 * snapshot and separate for agents on different ones; a server turned off or
 * blocked is detached and kept (with the user's values), a row is deleted
 * only once no pin references its snapshot — and a connector the user
 * attached by hand is never touched. The user's values are encrypted apart
 * from the plugin's own env. Over an in-memory provider table and link table.
 */

vi.mock('../host/runtimeHost', () => ({
  runtimeHost: { getPath: () => '/ud', keystore: { isEncryptionAvailable: () => false } }
}))

const { createPluginMcpProviders, managedRowSpec } = await import('./pluginMcpProviders')
const { encryptManagedSecrets, managedSecrets, missingManagedEnv } = await import('../mcp/managed')
import type { PluginMcpDeps, PluginServers } from './pluginMcpProviders'
import type { McpProviderRow, UpsertInput } from '../db/mcpProviders'
import type { PluginMcpServerSpec } from './pluginTree'

const USER = '__default__'
const ENTRY = '3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f'
const SHA1 = '1'.repeat(64)
const SHA2 = '2'.repeat(64)
const UV = { uvBin: '/ud/localdev/uv-0.12.10/uv', uvxBin: '/ud/localdev/uv-0.12.10/uvx' }

function spec(over: Partial<PluginMcpServerSpec> = {}): PluginMcpServerSpec {
  return { name: 'carbone', transport: 'stdio', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'], env: {}, url: null, headers: {}, ...over }
}

function pin(over: Partial<PluginServers> = {}): PluginServers {
  return { entryUuid: ENTRY, sha: SHA1, dir: '/cache/v1/carbone', servers: [spec()], disabled: [], ...over }
}

function world() {
  const rows: McpProviderRow[] = []
  const links: Array<{ agentId: string; id: string }> = []
  /** `entry/sha` keys some agent's pin names. */
  const pinned = new Set<string>()
  let next = 1
  const deps: PluginMcpDeps = {
    rows: () => rows,
    upsert: vi.fn((userId: string, input: UpsertInput) => {
      const existing = input.id ? rows.find((row) => row.id === input.id) : undefined
      const row = {
        ...(existing ?? {
          id: `m${next++}`,
          userId,
          createdAt: new Date(next),
          managedBy: input.managedBy ?? null,
          registryRef: null,
          authTokensEncrypted: null,
          clientInfo: null,
          oauthDiscoveryState: null,
          configRevision: 0,
          bearerTokenEncrypted: null,
          envSecretEncrypted: null,
          managedSpec: null,
          createdBySync: false,
          authType: 'oauth'
        }),
        name: input.name,
        transportType: input.transportType,
        command: input.command ?? null,
        args: input.args ?? null,
        url: input.url ?? null,
        env: input.env ?? null,
        enabled: input.enabled ?? true,
        ...(input.authType !== undefined ? { authType: input.authType } : {}),
        ...(input.managedSpec !== undefined ? { managedSpec: input.managedSpec } : {}),
        ...(input.envSecretEncrypted !== undefined ? { envSecretEncrypted: input.envSecretEncrypted } : {}),
        ...(input.bearerTokenEncrypted !== undefined ? { bearerTokenEncrypted: input.bearerTokenEncrypted } : {})
      } as McpProviderRow
      if (existing) rows.splice(rows.indexOf(existing), 1, row)
      else rows.push(row)
      return { id: row.id, created: !existing, row }
    }),
    remove: vi.fn(async (_userId: string, id: string) => {
      const at = rows.findIndex((row) => row.id === id)
      if (at >= 0) rows.splice(at, 1)
    }),
    disconnect: vi.fn(async () => undefined),
    attached: (_userId, agentId) => links.filter((link) => link.agentId === agentId).map((link) => link.id),
    attach: (_userId, agentId, id) => {
      links.push({ agentId, id })
    },
    detach: (_userId, agentId, id) => {
      const at = links.findIndex((link) => link.agentId === agentId && link.id === id)
      if (at >= 0) links.splice(at, 1)
    },
    agentsUsing: (id) => links.filter((link) => link.id === id).map((link) => link.agentId),
    referenced: vi.fn(() => pinned),
    uv: () => UV
  }
  /** The user types `values` into row `id` (what mcpService does on a Save). */
  const type = (id: string, values: Record<string, string>): void => {
    const row = rows.find((candidate) => candidate.id === id)!
    row.envSecretEncrypted = encryptManagedSecrets({ ...managedSecrets(row), ...values })
  }
  return { rows, links, pinned, deps, type, managed: createPluginMcpProviders(deps) }
}

const noBlock = (): string | null => null
const NO_NODE = 'Needs Node.js — install it from nodejs.org'

describe('managedRowSpec', () => {
  it('fills the plugin root, keeps the plugin’s env as written and makes every ${VAR} a slot of the user’s', () => {
    const wanted = managedRowSpec(
      spec({ args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs', '--key', '${API_KEY}'], env: { API_KEY: '${API_KEY}', MODE: 'fast', AUTH: 'Bearer ${TOKEN}', DATA: '${CLAUDE_PLUGIN_ROOT}/data' } }),
      '/cache/carbone',
      UV
    )
    expect(wanted).toEqual({
      transportType: 'stdio',
      command: 'node',
      args: ['/cache/carbone/server.mjs', '--key', '${API_KEY}'],
      url: null,
      // The user's values are never in here: they are encrypted apart.
      env: { API_KEY: '${API_KEY}', MODE: 'fast', AUTH: 'Bearer ${TOKEN}', DATA: '/cache/carbone/data' },
      managedSpec: { root: '/cache/carbone', slots: ['API_KEY', 'TOKEN'] }
    })
  })

  it('a literal value — even an empty one — is the plugin’s, never a value the user must give', () => {
    const wanted = managedRowSpec(spec({ env: { DEBUG: '', MODE: 'fast' } }), '/c', UV)
    expect(wanted.managedSpec.slots).toEqual([])
    expect(wanted.env).toEqual({ DEBUG: '', MODE: 'fast' })
  })

  it('runs a `uvx --from` of the plugin folder from the snapshot’s working copy, and records it to be made at launch', () => {
    const wanted = managedRowSpec(spec({ command: 'uvx', args: ['--from', '${CLAUDE_PLUGIN_ROOT}', 'carbone'] }), '/cache/carbone', UV, '/ud/plugin-work/e/s')
    expect(wanted).toMatchObject({ command: UV.uvxBin, args: ['--from', '/ud/plugin-work/e/s', 'carbone'], managedSpec: { root: '/cache/carbone', work: '/ud/plugin-work/e/s' } })
    // A package from an index needs no copy.
    expect(managedRowSpec(spec({ command: 'uvx', args: ['carbone-mcp'] }), '/cache/carbone', UV, '/ud/plugin-work/e/s').managedSpec).not.toHaveProperty('work')
  })

  it('runs a Python server through the managed uv', () => {
    expect(managedRowSpec(spec({ command: 'uvx', args: ['carbone-mcp', '--port', '0'] }), '/c', UV)).toMatchObject({
      command: UV.uvxBin,
      args: ['carbone-mcp', '--port', '0']
    })
    expect(managedRowSpec(spec({ command: 'python3', args: ['${CLAUDE_PLUGIN_ROOT}/s.py'] }), '/c', UV)).toMatchObject({
      command: UV.uvBin,
      args: ['run', '--no-project', 'python', '/c/s.py']
    })
    expect(managedRowSpec(spec({ command: 'uv', args: ['run', 'x'] }), '/c', UV)).toMatchObject({ command: UV.uvBin, args: ['run', 'x'] })
  })

  it('keeps an HTTP server’s URL with its placeholders, on OAuth when it declares no headers', () => {
    expect(managedRowSpec(spec({ transport: 'http', command: null, args: [], url: 'https://api.example/${TENANT}/mcp' }), '/c', UV)).toEqual({
      transportType: 'streamable-http',
      command: null,
      args: null,
      url: 'https://api.example/${TENANT}/mcp',
      env: null,
      authType: 'oauth',
      managedSpec: { root: '/c', slots: ['TENANT'] }
    })
  })

  it('an `Authorization: Bearer ${X}` header is the connector’s bearer token; other headers keep their ${VAR}s as slots', () => {
    const http = (headers: Record<string, string>) => spec({ transport: 'http', command: null, args: [], url: 'https://api.example/mcp', headers })
    expect(managedRowSpec(http({ Authorization: 'Bearer ${API_KEY}' }), '/c', UV)).toMatchObject({
      authType: 'bearer',
      managedSpec: { root: '/c', slots: [], bearer: true }
    })
    expect(managedRowSpec(http({ 'X-Api-Key': '${API_KEY}', 'X-Org': 'acme' }), '/c', UV)).toMatchObject({
      // Declared headers are the auth: no OAuth round-trip forced on top.
      authType: 'bearer',
      managedSpec: { root: '/c', slots: ['API_KEY'], headers: { 'X-Api-Key': '${API_KEY}', 'X-Org': 'acme' } }
    })
  })
})

describe('pluginMcpProviders.sync', () => {
  it('creates one managed provider per enabled server of the pin’s snapshot and attaches it', async () => {
    const { rows, links, managed } = world()
    const outcomes = await managed.sync(USER, 'a1', [pin({ servers: [spec(), spec({ name: 'off' })], disabled: ['off'] })], noBlock)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'carbone', managedBy: `plugin:${ENTRY}@${SHA1}`, command: 'node', args: ['/cache/v1/carbone/server.mjs'], enabled: true })
    expect(links).toEqual([{ agentId: 'a1', id: rows[0].id }])
    expect(outcomes).toEqual([{ entryUuid: ENTRY, name: 'carbone', mcpProviderId: rows[0].id, missingEnv: [] }])
  })

  it('says which settings a new connector still needs, and stores what the user gives encrypted, not in env', async () => {
    const { rows, managed, type } = world()
    const outcomes = await managed.sync(USER, 'a1', [pin({ servers: [spec({ env: { API_KEY: '${API_KEY}' } })] })], noBlock)
    expect(outcomes[0].missingEnv).toEqual(['API_KEY'])
    type(rows[0].id, { API_KEY: 'sk-typed' })
    expect(missingManagedEnv(rows[0])).toEqual([])
    expect(JSON.stringify(rows[0].env)).not.toContain('sk-typed')
    expect(managedSecrets(rows[0])).toEqual({ API_KEY: 'sk-typed' })
  })

  it('a literal "" in the plugin’s env never reads as missing', async () => {
    const { managed } = world()
    const outcomes = await managed.sync(USER, 'a1', [pin({ servers: [spec({ env: { DEBUG: '' } })] })], noBlock)
    expect(outcomes[0].missingEnv).toEqual([])
  })

  it('installs nothing a block names, and says why', async () => {
    const { rows, managed } = world()
    const outcomes = await managed.sync(USER, 'a1', [pin()], () => NO_NODE)
    expect(rows).toHaveLength(0)
    expect(outcomes).toEqual([{ entryUuid: ENTRY, name: 'carbone', blocked: NO_NODE, missingEnv: [] }])
  })

  it('a transient block detaches the connector and keeps it with the user’s values; recovery attaches the same row', async () => {
    const { rows, links, pinned, deps, managed, type } = world()
    pinned.add(`${ENTRY}/${SHA1}`)
    const withKey = [pin({ servers: [spec({ env: { API_KEY: '${API_KEY}' } })] })]
    await managed.sync(USER, 'a1', withKey, noBlock)
    const id = rows[0].id
    type(id, { API_KEY: 'sk-user-typed' })
    // Node missing this session (a slow login shell), or core's policy turning local servers off.
    const blocked = await managed.sync(USER, 'a1', withKey, () => NO_NODE)
    expect(blocked[0].blocked).toBe(NO_NODE)
    expect(links).toEqual([])
    expect(rows.map((row) => row.id)).toEqual([id])
    expect(deps.remove).not.toHaveBeenCalled()
    expect(deps.disconnect).toHaveBeenCalledWith(id)
    const back = await managed.sync(USER, 'a1', withKey, noBlock)
    expect(back[0]).toMatchObject({ mcpProviderId: id, missingEnv: [] })
    expect(managedSecrets(rows[0])).toEqual({ API_KEY: 'sk-user-typed' })
  })

  it('turning a server off and on keeps its row and the user’s values', async () => {
    const { rows, links, pinned, deps, managed, type } = world()
    pinned.add(`${ENTRY}/${SHA1}`)
    await managed.sync(USER, 'a1', [pin({ servers: [spec({ env: { API_KEY: '${API_KEY}' } })] })], noBlock)
    type(rows[0].id, { API_KEY: 'sk-1' })
    await managed.sync(USER, 'a1', [pin({ servers: [spec({ env: { API_KEY: '${API_KEY}' } })], disabled: ['carbone'] })], noBlock)
    expect(links).toEqual([])
    expect(rows).toHaveLength(1)
    expect(deps.remove).not.toHaveBeenCalled()
    await managed.sync(USER, 'a1', [pin({ servers: [spec({ env: { API_KEY: '${API_KEY}' } })] })], noBlock)
    expect(links).toEqual([{ agentId: 'a1', id: rows[0].id }])
    expect(managedSecrets(rows[0])).toEqual({ API_KEY: 'sk-1' })
  })

  it('agents on different snapshots get a row each and never re-point or disconnect the other’s', async () => {
    const { rows, links, pinned, deps, managed } = world()
    pinned.add(`${ENTRY}/${SHA1}`).add(`${ENTRY}/${SHA2}`)
    await managed.sync(USER, 'team', [pin()], noBlock)
    await managed.sync(USER, 'mine', [pin({ sha: SHA2, dir: '/cache/v2/carbone' })], noBlock)
    await managed.sync(USER, 'team', [pin()], noBlock)
    await managed.sync(USER, 'mine', [pin({ sha: SHA2, dir: '/cache/v2/carbone' })], noBlock)
    expect(rows).toHaveLength(2)
    const byAgent = (agentId: string) => rows.find((row) => row.id === links.find((link) => link.agentId === agentId)?.id)
    expect(byAgent('team')).toMatchObject({ managedBy: `plugin:${ENTRY}@${SHA1}`, args: ['/cache/v1/carbone/server.mjs'] })
    expect(byAgent('mine')).toMatchObject({ managedBy: `plugin:${ENTRY}@${SHA2}`, args: ['/cache/v2/carbone/server.mjs'] })
    expect(deps.upsert).toHaveBeenCalledTimes(2)
    expect(deps.disconnect).not.toHaveBeenCalled()
  })

  it('an update moves the agent to the new snapshot’s row, with the values the user gave the old one', async () => {
    const { rows, links, pinned, managed, type } = world()
    pinned.add(`${ENTRY}/${SHA1}`)
    const servers = [spec({ env: { API_KEY: '${API_KEY}' } })]
    await managed.sync(USER, 'a1', [pin({ servers })], noBlock)
    const old = rows[0].id
    type(old, { API_KEY: 'sk-kept' })
    pinned.clear()
    pinned.add(`${ENTRY}/${SHA2}`)
    const outcomes = await managed.sync(USER, 'a1', [pin({ sha: SHA2, dir: '/cache/v2/carbone', servers })], noBlock)
    expect(outcomes[0].missingEnv).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ managedBy: `plugin:${ENTRY}@${SHA2}`, args: ['/cache/v2/carbone/server.mjs'] })
    expect(rows[0].id).not.toBe(old)
    expect(links).toEqual([{ agentId: 'a1', id: rows[0].id }])
    expect(managedSecrets(rows[0])).toEqual({ API_KEY: 'sk-kept' })
  })

  it('shares one provider between two agents on the same snapshot and deletes it only once no pin references it', async () => {
    const { rows, links, pinned, deps, managed } = world()
    pinned.add(`${ENTRY}/${SHA1}`)
    await managed.sync(USER, 'a1', [pin()], noBlock)
    await managed.sync(USER, 'a2', [pin()], noBlock)
    expect(rows).toHaveLength(1)
    expect(links.map((link) => link.agentId).sort()).toEqual(['a1', 'a2'])
    // a1 unpins: detached from a1, kept for a2.
    await managed.sync(USER, 'a1', [], noBlock)
    expect(links.map((link) => link.agentId)).toEqual(['a2'])
    expect(rows).toHaveLength(1)
    // a2 unpins too; a pin elsewhere (an agent not synced yet) still references the snapshot: kept.
    await managed.sync(USER, 'a2', [], noBlock)
    expect(links).toEqual([])
    expect(rows).toHaveLength(1)
    expect(deps.remove).not.toHaveBeenCalled()
    // Nothing references it any more: the next sync that lets go of it… there is none, so collection does.
    pinned.clear()
    expect(await managed.collectUnreferenced(USER, pinned)).toBe(1)
    expect(rows).toHaveLength(0)
  })

  it('deletes a row at once when its agent lets go and no pin anywhere references it', async () => {
    const { rows, managed } = world()
    await managed.sync(USER, 'a1', [pin()], noBlock)
    await managed.sync(USER, 'a1', [], noBlock)
    expect(rows).toEqual([])
  })

  it('deletes nothing when the pins cannot all be read', async () => {
    const { rows, deps, managed } = world()
    await managed.sync(USER, 'a1', [pin()], noBlock)
    vi.mocked(deps.referenced).mockReturnValue(null)
    await managed.sync(USER, 'a1', [], noBlock)
    expect(rows).toHaveLength(1)
  })

  it('drops the connectors of a plugin no longer pinned, never one attached by hand', async () => {
    const { rows, links, deps, managed } = world()
    await managed.sync(USER, 'a1', [pin({ dir: '/c' })], noBlock)
    deps.upsert(USER, { name: 'mine', transportType: 'stdio', command: 'my-server' })
    deps.attach(USER, 'a1', rows[1].id)
    await managed.sync(USER, 'a1', [], noBlock)
    expect(rows.map((row) => row.name)).toEqual(['mine'])
    expect(links).toEqual([{ agentId: 'a1', id: rows[0].id }])
  })

  it('leaves what the agent has while the snapshot is not on this computer', async () => {
    const { rows, links, managed } = world()
    await managed.sync(USER, 'a1', [pin()], noBlock)
    await managed.sync(USER, 'a1', [pin({ sha: SHA2, dir: null, servers: [] })], noBlock)
    expect(rows).toHaveLength(1)
    expect(links).toHaveLength(1)
  })

  it('a bearer-header server answers that its token is still to be given', async () => {
    const { managed } = world()
    const http = spec({ transport: 'http', command: null, args: [], url: 'https://api.example/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } })
    const outcomes = await managed.sync(USER, 'a1', [pin({ servers: [http] })], noBlock)
    expect(outcomes[0]).toMatchObject({ missingEnv: [], needsBearer: true })
  })
})
