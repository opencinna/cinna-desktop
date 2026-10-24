import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Of, tgzOf, type TarMember } from '../kit/testSupport/skillTar'

/**
 * Marketplace plugins in local agents, against a fake core: add (the batch
 * lookup, both digest checks, the safe unpack into the read-only cache, the
 * `marketplace_plugins[]` pin, the managed connector and its next step),
 * the refusals as data (a digest that matches neither the header nor the
 * pin, an unsafe archive, a pending snapshot, a missing runtime), turning
 * parts off, remove, and a pin core no longer serves — still delivered from
 * the cache, reading "No longer available to you" or "Update available".
 * Real: the agent folder, the manifest, the cache, the archive reader, the
 * skill delivery rows. Faked: the network, the agent index, the git origin,
 * the provider and link tables, the PATH lookup.
 */

const PROFILE = 'profile-cinna'
const HOST = 'https://cinna.test'
const USER = '__default__'
const AGENT_ID = 'folder:11111111-2222-4333-8444-555566667777'
const MANIFEST_ID = '11111111-2222-4333-8444-555566667777'
const ENTRY = '3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f'
const MARKETPLACE = '8d2f4a6b-1c3e-4a5b-9c7d-0e1f2a3b4c5d'

const host = vi.hoisted(() => ({ userData: '', signedIn: true }))
const cinnaFetch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const cinnaFetchBytes = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const located = vi.hoisted(() => ({ dir: '' }))
const remote = vi.hoisted(() => ({ ownRepo: false, originUrl: null as string | null, cinnaServer: null as string | null }))
const tables = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], links: [] as { agentId: string; id: string }[], next: 1 }))
const path = vi.hoisted(() => ({ found: {} as Record<string, string | null> }))
const ensureUv = vi.hoisted(() => vi.fn(async () => ({ uvBin: '/ud/uv', uvxBin: '/ud/uvx', env: {} })))

const reveal = vi.hoisted(() => ({ showItemInFolder: vi.fn() }))
vi.mock('../host/runtimeHost', () => ({
  runtimeHost: { getPath: () => host.userData, keystore: { isEncryptionAvailable: () => false }, shell: { showItemInFolder: reveal.showItemInFolder } }
}))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => PROFILE, getSettingsScopeUserId: () => USER }))
vi.mock('../host/events', () => ({ publishEvent: vi.fn() }))
vi.mock('./cinna-http', () => ({ cinnaFetch, cinnaFetchBytes }))
vi.mock('./libraryService', () => ({
  catalogItemPath: (uuid: string) => `/api/v1/catalog/items/${encodeURIComponent(uuid)}`,
  libraryService: {
    hostOf: (profile: string) => (profile === PROFILE && host.signedIn ? HOST : null),
    knownHosts: () => new Set([HOST]),
    cached: () => ({ items: [], agents: [] }),
    refresh: async () => ({ items: [], agents: [] })
  }
}))
vi.mock('./localAgents/localAgentService', () => ({
  localAgentService: { get: () => ({ rootId: 'root-1', path: located.dir, skills: [] }) }
}))
// The agent index the pins are read through (garbage collection, a row's "is any pin still on it").
vi.mock('./localAgents/scannerService', () => ({
  scannerService: { markAllRootsDirty: () => {}, scanRootCached: () => ({ agents: located.dir ? [{ path: located.dir, skills: [] }] : [] }) }
}))
vi.mock('./serviceCredentials/service', () => ({ serviceCredentialService: { autoAttachSkills: async () => [], detachUnusedAutoAttachments: async () => [] } }))
vi.mock('../db/agents', () => ({ agentRepo: { listFolder: () => [] } }))
vi.mock('../db/agentRoots', () => ({ agentRootRepo: { list: () => [{ id: 'root-1' }] } }))
vi.mock('./localAgents/gitService', () => ({ gitService: { readShareRemote: async () => ({ ...remote, refusal: null }) } }))
vi.mock('./localAgents/defaultEngineService', () => ({ defaultEngineService: { current: () => 'claude' } }))
vi.mock('./conductorBridge', () => ({ conductorBridge: { refreshAgent: () => {} } }))
vi.mock('../mcp/manager', () => ({ mcpManager: { disconnect: async () => undefined } }))
vi.mock('../shell/env', () => ({ which: async (bin: string) => path.found[bin] ?? null, clearToolCache: () => {} }))
vi.mock('../localdev/toolchain', () => ({
  managedUvLayout: () => ({ uvBin: '/ud/uv', uvxBin: '/ud/uvx', env: {} }),
  toolchain: { ensureUv }
}))
vi.mock('../db/mcpProviders', () => ({
  mcpProviderRepo: {
    list: () => tables.rows,
    listAllManaged: () => tables.rows.filter((row) => typeof row.managedBy === 'string'),
    upsert: (userId: string, input: Record<string, unknown>) => {
      const existing = input.id ? tables.rows.find((row) => row.id === input.id) : undefined
      const row: Record<string, unknown> = { ...(existing ?? { id: `m${tables.next++}`, userId, createdAt: new Date() }), ...input, managedBy: existing?.managedBy ?? input.managedBy ?? null }
      if (existing) tables.rows.splice(tables.rows.indexOf(existing), 1, row)
      else tables.rows.push(row)
      return { id: row.id, created: !existing, row }
    },
    delete: (_userId: string, id: string) => {
      tables.rows = tables.rows.filter((row) => row.id !== id)
      return true
    }
  }
}))
vi.mock('../db/agentMcp', () => ({
  agentMcpRepo: {
    listProviderIds: (_user: string, agentId: string) => tables.links.filter((l) => l.agentId === agentId).map((l) => l.id),
    attach: (agentId: string, id: string) => {
      tables.links.push({ agentId, id })
      return true
    },
    detach: (agentId: string, id: string) => {
      tables.links = tables.links.filter((l) => !(l.agentId === agentId && l.id === id))
      return true
    },
    agentIdsFor: (id: string) => tables.links.filter((l) => l.id === id).map((l) => l.agentId)
  }
}))

const { marketplacePluginService, toPluginEntry } = await import('./marketplacePluginService')
const { addonPolicies } = await import('./addonDirectory/policy')
const { marketplacePluginCache } = await import('./marketplacePluginCache')
const { removeTree } = await import('./catalogSkillCache')
const { deliveredSkillRows } = await import('./pluginSkills')
const { stdioRuntimes } = await import('./stdioRuntimes')
const { CinnaApiError } = await import('../errors')
const { encryptManagedSecrets, managedSecrets, managedLaunchBlock, pluginManagedBy, pluginWorkDir } = await import('../mcp/managed')

let root: string
let agentDir: string

const MCP_JSON = JSON.stringify({ mcpServers: { carbone: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'], env: { CARBONE_KEY: '${CARBONE_KEY}' } } } })

/** A plugin archive as core serves it: every member under `<name>/`. */
function pluginTgz(version = '1.0.0', extra: TarMember[] = [], name = 'carbone', mcp = MCP_JSON): Buffer {
  return tgzOf([
    { name: `${name}/.claude-plugin/plugin.json`, body: JSON.stringify({ name, version, description: 'Documents.' }) },
    { name: `${name}/skills/report/SKILL.md`, body: '---\nname: report\ndescription: Renders a report.\n---\n\n# Report\n' },
    { name: `${name}/commands/render.md`, body: '---\ndescription: Render a template\n---\nRender $ARGUMENTS\n' },
    { name: `${name}/.mcp.json`, body: mcp },
    { name: `${name}/server.mjs`, body: 'console.log("hi")\n', mode: 0o755 },
    ...extra
  ])
}

function entry(archive: Buffer | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENTRY,
    marketplace_id: MARKETPLACE,
    name: 'carbone',
    description: 'Documents from templates.',
    version: '1.0.0',
    commit_hash: 'abc123',
    plugin_type: 'claude',
    supported: true,
    unsupported_reason: null,
    archive_sha256: archive ? sha256Of(archive) : null,
    archive_size: archive ? archive.length : null,
    snapshot_status: archive ? 'ready' : 'pending',
    snapshot_reason: null,
    runs_code: true,
    components: {
      skills: [{ name: 'report', has_scripts: false }],
      commands: ['render'],
      agents: [],
      hooks: null,
      mcp_servers: [{ name: 'carbone', transport: 'stdio', runtime: 'node', auth: 'env', env: [{ name: 'CARBONE_KEY', secret: true }] }],
      lsp_servers: []
    },
    marketplace_name: 'Official',
    marketplace_owner: 'Anthropic',
    repository_url: 'https://github.com/example/plugins',
    ...over
  }
}

/** The batch lookup answers `visible`; an archive request answers from `archives` by digest, with `header` as its digest header. */
function serve(visible: Record<string, unknown>[], archives: Buffer[], header: (bytes: Buffer) => string = sha256Of): void {
  cinnaFetch.mockImplementation(async (...args: unknown[]) => {
    const url = args[1] as string
    if (url.startsWith('/api/v1/llm-plugins/plugins?ids=')) {
      const ids = decodeURIComponent(url.split('ids=')[1]).split(',')
      const data = visible.filter((row) => ids.includes(String(row.id)))
      return { data, count: data.length }
    }
    throw new Error(`unexpected ${url}`)
  })
  cinnaFetchBytes.mockImplementation(async (...args: unknown[]) => {
    const url = args[1] as string
    expect(url).toMatch(/^\/api\/v1\/llm-plugins\/plugins\/[0-9a-f-]{36}\/archive\?sha256=[0-9a-f]{64}$/)
    const sha = url.match(/sha256=([0-9a-f]{64})/)?.[1]
    const bytes = archives.find((archive) => sha256Of(archive) === sha)
    if (!bytes) throw new CinnaApiError('request_failed', 'Cinna API 404', '{"detail":{"code":"snapshot_missing"}}', 404)
    return { ok: true, bytes, headers: new Headers({ 'X-Archive-Sha256': header(bytes) }) }
  })
}

function writeManifest(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(agentDir, 'cinna-agent.json'), `${JSON.stringify({ id: MANIFEST_ID, slug: 'docs', name: 'Docs', ...extra }, null, 2)}\n`)
}

const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(agentDir, 'cinna-agent.json'), 'utf8'))
const snapshotDir = (archive: Buffer): string => join(host.userData, 'marketplace-plugins', 'https-cinna.test', ENTRY, sha256Of(archive), 'carbone')
const pinOf = (archive: Buffer, over: Record<string, unknown> = {}) => ({
  entry_uuid: ENTRY,
  marketplace_uuid: MARKETPLACE,
  marketplace_name: 'Official',
  name: 'carbone',
  archive_sha256: sha256Of(archive),
  version: '1.0.0',
  commit_hash: 'abc123',
  ...over
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-marketplace-plugins-'))
  host.userData = join(root, 'userData')
  host.signedIn = true
  agentDir = join(root, 'Local', 'docs')
  mkdirSync(agentDir, { recursive: true })
  writeManifest()
  located.dir = agentDir
  remote.ownRepo = false
  remote.originUrl = null
  tables.rows = []
  tables.links = []
  path.found = { node: '/usr/local/bin/node', npx: '/usr/local/bin/npx' }
  cinnaFetch.mockReset()
  cinnaFetchBytes.mockReset()
  ensureUv.mockClear()
  marketplacePluginCache._reset()
  marketplacePluginService._reset()
  stdioRuntimes._reset()
})

afterEach(() => {
  removeTree(root)
})

describe('toPluginEntry', () => {
  it('maps core’s plugin row, components included', () => {
    const archive = pluginTgz()
    expect(toPluginEntry(entry(archive))).toMatchObject({
      entryUuid: ENTRY,
      name: 'carbone',
      pluginType: 'claude',
      archiveSha256: sha256Of(archive),
      snapshotStatus: 'ready',
      runsCode: true,
      components: { commands: ['render'], mcpServers: [{ name: 'carbone', runtime: 'node', auth: 'env', env: [{ name: 'CARBONE_KEY', secret: true }] }] }
    })
  })
})

describe('addToAgent', () => {
  it('downloads the snapshot, checks both digests, caches it read-only, pins it and makes its connector', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    const result = await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    expect(result).toEqual({ ok: true, name: 'carbone', archiveSha256: sha256Of(archive), next: 'env' })
    expect(manifest().marketplace_plugins).toEqual([pinOf(archive)])
    const dir = snapshotDir(archive)
    expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).toBe(MCP_JSON)
    expect(statSync(join(dir, 'server.mjs')).mode & 0o777).toBe(0o555)
    expect(statSync(join(dir, 'commands', 'render.md')).mode & 0o777).toBe(0o444)
    // One managed connector, attached, its command pointing into the cache, its key still to fill in.
    expect(tables.rows).toHaveLength(1)
    expect(tables.rows[0]).toMatchObject({
      name: 'carbone',
      managedBy: `plugin:${ENTRY}@${sha256Of(archive)}`,
      transportType: 'stdio',
      command: 'node',
      args: [join(dir, 'server.mjs')],
      // The plugin's env as written; the user's value is stored encrypted, apart.
      env: { CARBONE_KEY: '${CARBONE_KEY}' },
      managedSpec: { root: dir, slots: ['CARBONE_KEY'] },
      envSecretEncrypted: null
    })
    expect(tables.links).toEqual([{ agentId: AGENT_ID, id: tables.rows[0].id }])
    // Its skill joins the agent's delivery.
    const delivered = deliveredSkillRows(agentDir, manifest()).filter((row) => row.source === 'plugin')
    expect(delivered.map((row) => [row.name, row.deliverable, row.path])).toEqual([['report', true, join(dir, 'skills', 'report', 'SKILL.md')]])
  })

  it('refuses bytes whose digest is not the server’s header, and keeps nothing', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive], () => 'f'.repeat(64))
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'hash_mismatch' })
    expect(manifest().marketplace_plugins).toBeUndefined()
    expect(existsSync(snapshotDir(archive))).toBe(false)
    expect(tables.rows).toEqual([])
  })

  it('refuses bytes that match their header but not the digest the entry names', async () => {
    const listed = pluginTgz('1.0.0')
    const served = pluginTgz('6.6.6')
    serve([entry(listed)], [])
    cinnaFetchBytes.mockResolvedValue({ ok: true, bytes: served, headers: new Headers({ 'X-Archive-Sha256': sha256Of(served) }) })
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'hash_mismatch' })
    expect(manifest().marketplace_plugins).toBeUndefined()
  })

  it('refuses an archive with a link or a path outside the plugin', async () => {
    for (const bad of [
      [{ name: 'carbone/evil', type: '2' as const, linkname: '/etc/passwd' }],
      [{ name: 'carbone/../escape.txt', body: 'x' }],
      [{ name: '/abs/path.txt', body: 'x' }]
    ]) {
      const archive = pluginTgz('1.0.0', bad)
      serve([entry(archive)], [archive])
      marketplacePluginCache._reset()
      expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'invalid_archive' })
      expect(existsSync(snapshotDir(archive))).toBe(false)
    }
    expect(manifest().marketplace_plugins).toBeUndefined()
  })

  it('refuses a plugin core is still preparing, and one with a Node server on a computer without Node.js', async () => {
    serve([entry(null)], [])
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'preparing' })
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    path.found = {}
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toEqual({
      ok: false,
      code: 'blocked',
      message: 'Needs Node.js — install it from nodejs.org'
    })
    expect(manifest().marketplace_plugins).toBeUndefined()
    expect(tables.rows).toEqual([])
    expect(tables.links).toEqual([])
  })

  it('judges the runtime by the snapshot’s real command, not core’s description of it', async () => {
    // Core says nothing about a runtime; the tree's `.mcp.json` runs `npx`. No Node.js here: refused, nothing attached.
    const npx = pluginTgz('1.0.0', [], 'carbone', JSON.stringify({ mcpServers: { carbone: { command: 'npx', args: ['-y', 'carbone-mcp'] } } }))
    const silent = { skills: [], commands: [], agents: [], hooks: null, mcp_servers: [{ name: 'carbone', transport: 'stdio', runtime: null, auth: 'none', env: [] }], lsp_servers: [] }
    serve([entry(npx, { components: silent })], [npx])
    path.found = {}
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'blocked', message: 'Needs Node.js — install it from nodejs.org' })
    expect(manifest().marketplace_plugins).toBeUndefined()
    expect(tables.rows).toEqual([])
    // Core says Node; the tree really runs Python through uvx: no Node.js needed, and uv is installed first.
    const uvx = pluginTgz('1.0.1', [], 'carbone', JSON.stringify({ mcpServers: { carbone: { command: 'uvx', args: ['carbone-mcp'] } } }))
    serve([entry(uvx)], [uvx])
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: true })
    expect(ensureUv).toHaveBeenCalledTimes(1)
    expect(tables.rows[0]).toMatchObject({ command: '/ud/uvx', args: ['carbone-mcp'] })
  })

  it('installs the managed uv first for a Python server', async () => {
    const archive = pluginTgz('1.0.0', [], 'carbone', JSON.stringify({ mcpServers: { p: { command: 'python3', args: ['${CLAUDE_PLUGIN_ROOT}/server.py'] } } }))
    serve([entry(archive)], [archive])
    ensureUv.mockRejectedValueOnce(new Error('offline'))
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'runtime_failed' })
    expect(manifest().marketplace_plugins).toBeUndefined()
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: true })
    expect(ensureUv).toHaveBeenCalledTimes(2)
  })

  it('refuses a second pin of the same plugin', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    writeManifest({ marketplace_plugins: [pinOf(archive)] })
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toEqual({ ok: false, code: 'already_added', message: 'This agent already has this plugin.' })
  })

  it('names the other marketplace when a different plugin of the same name is already pinned', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    writeManifest({ marketplace_plugins: [pinOf(archive, { entry_uuid: '9f9f9f9f-1111-4222-8333-444455556666', marketplace_name: 'Team tools' })] })
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toEqual({
      ok: false,
      code: 'already_added',
      message: 'This agent already has a plugin named carbone from Team tools.'
    })
  })
})

describe('setDisabled and remove', () => {
  it('turns a server off (detached, its row and values kept) and back on, then remove drops the pin and the connector', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    expect(tables.rows).toHaveLength(1)
    const id = tables.rows[0].id
    tables.rows[0].envSecretEncrypted = encryptManagedSecrets({ CARBONE_KEY: 'sk-typed' })

    expect(await marketplacePluginService.setDisabled(USER, AGENT_ID, 'carbone', { mcpServers: ['carbone'], hooks: true })).toMatchObject({ ok: true })
    expect((manifest().marketplace_plugins as Record<string, unknown>[])[0].disabled).toEqual({ hooks: true, mcp_servers: ['carbone'] })
    expect(tables.links).toEqual([])
    expect(tables.rows.map((row) => row.id)).toEqual([id])

    await marketplacePluginService.setDisabled(USER, AGENT_ID, 'carbone', { mcpServers: [], hooks: false, skills: ['report'] })
    expect((manifest().marketplace_plugins as Record<string, unknown>[])[0].disabled).toEqual({ skills: ['report'] })
    expect(tables.links).toEqual([{ agentId: AGENT_ID, id }])
    expect(managedSecrets(tables.rows[0] as never)).toEqual({ CARBONE_KEY: 'sk-typed' })
    expect(deliveredSkillRows(agentDir, manifest()).some((row) => row.source === 'plugin')).toBe(false)

    // A working copy made at a launch goes with the last pin of its snapshot.
    const work = pluginWorkDir(tables.rows[0].managedBy as string)!
    mkdirSync(work, { recursive: true })
    writeFileSync(`${work}.source`, '{}')
    expect(await marketplacePluginService.remove(USER, AGENT_ID, 'carbone')).toMatchObject({ ok: true })
    expect(manifest().marketplace_plugins).toEqual([])
    expect(tables.rows).toEqual([])
    expect(tables.links).toEqual([])
    expect(existsSync(work)).toBe(false)
    expect(existsSync(`${work}.source`)).toBe(false)
  })
})

describe('a pin core no longer serves', () => {
  it('is still delivered from the cache, and reads no longer available when the entry is gone', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    // The entry leaves the person's view: batch lookup absent, downloads 404.
    serve([], [])
    const status = await marketplacePluginService.status(USER, AGENT_ID)
    expect(status.ok && status.plugins[0]).toMatchObject({ availability: 'unavailable', availabilityText: 'No longer available to you', cache: 'ready' })
    expect(deliveredSkillRows(agentDir, manifest()).filter((row) => row.source === 'plugin').map((row) => row.name)).toEqual(['report'])
    // A banned or no-longer-allowed entry (core K5): Update and a re-add are refused, and the pin stays as it was.
    const notVisible = { ok: false, code: 'not_found', message: 'This plugin is no longer in a marketplace you can see.' }
    expect(await marketplacePluginService.update(USER, AGENT_ID, 'carbone')).toEqual(notVisible)
    expect(await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)).toEqual(notVisible)
    expect(manifest().marketplace_plugins).toEqual([pinOf(archive)])
  })

  it('reads update available when core moved on and no longer keeps the pinned snapshot', async () => {
    const old = pluginTgz('1.0.0')
    const latest = pluginTgz('2.0.0')
    serve([entry(old)], [old])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    serve([entry(latest, { version: '2.0.0' })], [latest])
    const status = await marketplacePluginService.status(USER, AGENT_ID)
    expect(status.ok && status.plugins[0]).toMatchObject({
      availability: 'update_available',
      availabilityText: 'Update available',
      latestSha256: sha256Of(latest),
      latestVersion: '2.0.0',
      cache: 'ready'
    })
    expect(deliveredSkillRows(agentDir, manifest()).some((row) => row.source === 'plugin' && row.path.startsWith(snapshotDir(old)))).toBe(true)
    expect(await marketplacePluginService.update(USER, AGENT_ID, 'carbone')).toMatchObject({ ok: true, archiveSha256: sha256Of(latest) })
    expect(tables.rows[0].args).toEqual([join(snapshotDir(latest), 'server.mjs')])
  })

  it('a pin not on this computer whose snapshot core dropped is a snapshot_missing failure, nothing thrown', async () => {
    const old = pluginTgz('1.0.0')
    writeManifest({ marketplace_plugins: [pinOf(old)] })
    serve([entry(pluginTgz('2.0.0'))], [])
    const result = await marketplacePluginService.ensurePinned(USER, AGENT_ID)
    expect(result).toEqual({ ok: true, fetched: [], failed: [{ name: 'carbone', code: 'snapshot_missing', message: 'The server no longer keeps this version of the plugin.' }] })
    expect(tables.rows).toEqual([])
  })
})

describe('status', () => {
  it('reports each part: skills (an own skill wins a clash), commands, hooks by engine, and the connector’s step', async () => {
    mkdirSync(join(agentDir, 'skills', 'report'), { recursive: true })
    writeFileSync(join(agentDir, 'skills', 'report', 'SKILL.md'), '---\nname: report\ndescription: Mine.\n---\n')
    const archive = pluginTgz('1.0.0', [
      { name: 'carbone/hooks/hooks.json', body: '{"hooks":{"PostToolUse":[{"hooks":[]}],"SessionStart":[{"hooks":[]}]}}' },
      { name: 'carbone/agents/layout.md', body: '---\nname: layout-checker\n---\nChecks layouts.\n' }
    ])
    serve([entry(archive)], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    const status = await marketplacePluginService.status(USER, AGENT_ID)
    expect(status.ok).toBe(true)
    const plugin = status.ok ? status.plugins[0] : null
    expect(plugin).toMatchObject({
      engine: 'claude',
      compatibility: { level: 'compatible' },
      skills: [{ name: 'report', disabled: false, delivered: false, reason: 'This agent already has a skill with this name, which wins.' }],
      commands: ['render'],
      hasAgents: true,
      agents: ['layout-checker'],
      hasHooks: true,
      hookEvents: ['PostToolUse', 'SessionStart'],
      hooksDelivered: true,
      mcpServers: [{ name: 'carbone', transport: 'stdio', disabled: false, setup: 'env', missingEnv: ['CARBONE_KEY'] }]
    })
    expect(deliveredSkillRows(agentDir, manifest()).filter((row) => row.name === 'report').map((row) => row.source)).toEqual(['authored'])
  })

  it('titles the row from the marketplace’s display title, else the pin’s name, and flags hooks the admin forbids', async () => {
    const archive = pluginTgz('1.0.0', [{ name: 'carbone/hooks/hooks.json', body: '{"hooks":{}}' }])
    serve([entry(archive, { title: 'Carbone Reports' })], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    let status = await marketplacePluginService.status(USER, AGENT_ID)
    expect(status.ok && status.plugins[0]).toMatchObject({ name: 'carbone', title: 'Carbone Reports', hooksBlockedByPolicy: false, hooksDelivered: true })

    // The entry left the person's view: the pin's own name stands in.
    serve([], [])
    addonPolicies._configure({
      account: () => 'profile@https://cinna.test',
      load: () => ({ externalDirectories: true, customMcp: true, pluginHooks: false, stdioMcp: true }),
      save: () => undefined
    })
    try {
      status = await marketplacePluginService.status(USER, AGENT_ID)
      expect(status.ok && status.plugins[0]).toMatchObject({
        title: 'carbone',
        hooksBlockedByPolicy: true,
        hooksDelivered: false,
        hooksReason: 'Plugin hooks are turned off by your admin.'
      })
      // Turned off on the pin, the policy blocks nothing.
      await marketplacePluginService.setDisabled(USER, AGENT_ID, 'carbone', { hooks: true })
      status = await marketplacePluginService.status(USER, AGENT_ID)
      expect(status.ok && status.plugins[0]).toMatchObject({ hooksBlockedByPolicy: false })
    } finally {
      addonPolicies._reset()
    }
  })
})

describe('reveal', () => {
  it('shows the pinned plugin’s cached folder through the host, and refuses as data what is not there', async () => {
    reveal.showItemInFolder.mockClear()
    expect(marketplacePluginService.reveal(USER, AGENT_ID, 'carbone')).toMatchObject({ ok: false, code: 'not_found' })
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    expect(marketplacePluginService.reveal(USER, AGENT_ID, 'carbone')).toEqual({ ok: true })
    expect(reveal.showItemInFolder).toHaveBeenCalledWith(snapshotDir(archive))

    marketplacePluginCache._reset()
    removeTree(join(host.userData, 'marketplace-plugins'))
    expect(marketplacePluginService.reveal(USER, AGENT_ID, 'carbone')).toEqual({ ok: false, code: 'not_found', message: 'This plugin is not on this computer yet.' })
    expect(reveal.showItemInFolder).toHaveBeenCalledTimes(1)
  })
})

describe('managed connectors over time', () => {
  it('a Node.js that goes missing for a session detaches the connector and keeps what the user typed; it comes back as it was', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    const id = tables.rows[0].id
    tables.rows[0].envSecretEncrypted = encryptManagedSecrets({ CARBONE_KEY: 'sk-user-typed' })
    path.found = {}
    stdioRuntimes._reset()
    await marketplacePluginService.ensurePinned(USER, AGENT_ID)
    expect(tables.links).toEqual([])
    expect(tables.rows.map((row) => row.id)).toEqual([id])
    const status = await marketplacePluginService.status(USER, AGENT_ID)
    expect(status.ok && status.plugins[0].mcpServers[0]).toMatchObject({ name: 'carbone', blocked: 'Needs Node.js — install it from nodejs.org' })
    path.found = { node: '/usr/local/bin/node' }
    stdioRuntimes._reset()
    await marketplacePluginService.ensurePinned(USER, AGENT_ID)
    expect(tables.links).toEqual([{ agentId: AGENT_ID, id }])
    expect(managedSecrets(tables.rows[0] as never)).toEqual({ CARBONE_KEY: 'sk-user-typed' })
  })

  it('a remove waits for a slow background ensure of the same agent, and leaves no connector behind', async () => {
    const archive = pluginTgz('1.0.0', [], 'carbone', JSON.stringify({ mcpServers: { carbone: { command: 'uvx', args: ['carbone-mcp'] } } }))
    serve([entry(archive)], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    expect(tables.links).toHaveLength(1)
    let release: () => void = () => {}
    ensureUv.mockImplementationOnce(() => new Promise((done) => (release = () => done({ uvBin: '/ud/uv', uvxBin: '/ud/uvx', env: {} }))))
    const ensuring = marketplacePluginService.ensurePinned(USER, AGENT_ID)
    const removing = marketplacePluginService.remove(USER, AGENT_ID, 'carbone')
    await new Promise((done) => setTimeout(done, 20))
    // The remove has not run yet: it is queued behind the ensure, which is waiting for uv.
    expect((manifest().marketplace_plugins as unknown[]).length).toBe(1)
    release()
    expect(await ensuring).toMatchObject({ ok: true })
    expect(await removing).toMatchObject({ ok: true })
    expect(manifest().marketplace_plugins).toEqual([])
    expect(tables.links).toEqual([])
    expect(tables.rows).toEqual([])
  })

  it('a cached copy changed on disk is not delivered, its server is not launched, and Update downloads it again', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    const dir = snapshotDir(archive)
    const server = join(dir, 'server.mjs')
    // Something with the user's rights edits the plugin's code in the read-only cache.
    chmodSync(server, 0o755)
    writeFileSync(server, 'console.log("pwned")\n')
    marketplacePluginCache._resetIntegrity()
    expect(deliveredSkillRows(agentDir, manifest()).filter((row) => row.source === 'plugin')).toEqual([])
    const status = await marketplacePluginService.status(USER, AGENT_ID)
    expect(status.ok && status.plugins[0]).toMatchObject({ cache: 'failed', cacheMessage: 'The cached copy was changed on disk — Update to restore it' })
    expect(managedLaunchBlock(tables.rows[0] as never)).toBe('The cached copy was changed on disk — Update to restore it')
    const work = pluginWorkDir(pluginManagedBy(ENTRY, sha256Of(archive)))!
    mkdirSync(work, { recursive: true })
    expect(await marketplacePluginService.update(USER, AGENT_ID, 'carbone')).toMatchObject({ ok: true, archiveSha256: sha256Of(archive) })
    expect(readFileSync(server, 'utf8')).toBe('console.log("hi")\n')
    // Its working copy was made from the changed tree: discarded, copied again at the next launch.
    expect(existsSync(work)).toBe(false)
    expect(managedLaunchBlock(tables.rows[0] as never)).toBeNull()
    expect(deliveredSkillRows(agentDir, manifest()).filter((row) => row.source === 'plugin').map((row) => row.name)).toEqual(['report'])
    // A file added beside the plugin's own is a change too.
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'sitecustomize.py'), 'x = 1\n')
    expect(managedLaunchBlock(tables.rows[0] as never)).toBe('The cached copy was changed on disk — Update to restore it')
  })

  it('garbage collection keeps a snapshot a connector still runs from, and drops a connector nothing references', async () => {
    const old = pluginTgz('1.0.0')
    serve([entry(old)], [old])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    const oldRow = tables.rows[0].id
    // Another agent (not a kit agent this computer reads pins from) still uses the old snapshot's connector.
    tables.links.push({ agentId: 'folder:other', id: oldRow as string })
    const latest = pluginTgz('2.0.0')
    serve([entry(latest, { version: '2.0.0' })], [latest])
    const oldWork = pluginWorkDir(pluginManagedBy(ENTRY, sha256Of(old)))!
    const strayWork = pluginWorkDir(pluginManagedBy(ENTRY, 'f'.repeat(64)))!
    mkdirSync(oldWork, { recursive: true })
    await marketplacePluginService.update(USER, AGENT_ID, 'carbone')
    expect(tables.rows.map((row) => row.id)).toContain(oldRow)
    // The old snapshot's connector still runs: its working copy stays.
    expect(existsSync(oldWork)).toBe(true)
    mkdirSync(strayWork, { recursive: true })
    expect(marketplacePluginService.collectGarbage()).toMatchObject({ ok: true, removed: 0 })
    expect(existsSync(snapshotDir(old))).toBe(true)
    expect(existsSync(oldWork)).toBe(true)
    // A copy of a snapshot nothing references any more is swept at start.
    expect(existsSync(strayWork)).toBe(false)
    // Once nothing uses it, the connector goes, and its snapshot with it.
    tables.links = tables.links.filter((link) => link.agentId !== 'folder:other')
    expect(marketplacePluginService.collectGarbage()).toMatchObject({ ok: true, removed: 1 })
    expect(tables.rows.map((row) => row.id)).not.toContain(oldRow)
    expect(existsSync(snapshotDir(old))).toBe(false)
    expect(existsSync(snapshotDir(latest))).toBe(true)
    expect(existsSync(oldWork)).toBe(false)
  })

  it('starts a connector at app start only when an agent has it and it can run', async () => {
    const archive = pluginTgz()
    serve([entry(archive)], [archive])
    await marketplacePluginService.addToAgent(USER, AGENT_ID, ENTRY)
    const row = () => tables.rows[0] as never
    // Its key not given yet.
    expect(await marketplacePluginService.startsUnattended(row())).toBe(false)
    tables.rows[0].envSecretEncrypted = encryptManagedSecrets({ CARBONE_KEY: 'sk' })
    expect(await marketplacePluginService.startsUnattended(row())).toBe(true)
    // No Node.js this session.
    path.found = {}
    stdioRuntimes._reset()
    expect(await marketplacePluginService.startsUnattended(row())).toBe(false)
    path.found = { node: '/usr/local/bin/node' }
    stdioRuntimes._reset()
    // Not attached to any agent.
    tables.links = []
    expect(await marketplacePluginService.startsUnattended(row())).toBe(false)
  })
})
