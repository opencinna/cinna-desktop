import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The directory as the app wires it: a directory MCP entry becomes a local
 * provider carrying its ref, connected without a browser, and the step the
 * picker shows next follows from how that first connect went. Skill pins and
 * attaches reach the existing services.
 */

const mcp = vi.hoisted(() => ({ createFromDirectory: vi.fn(), delete: vi.fn(async () => undefined) }))
const agentMcp = vi.hoisted(() => ({ list: vi.fn(() => [] as string[]), attach: vi.fn(), detach: vi.fn() }))
const catalog = vi.hoisted(() => ({ addToAgent: vi.fn(), remove: vi.fn() }))
const marketplace = vi.hoisted(() => ({ addToAgent: vi.fn(), remove: vi.fn(), discover: vi.fn() }))
const agents = vi.hoisted(() => ({ get: vi.fn() }))
const repo = vi.hoisted(() => ({ list: vi.fn(() => []), findByRegistryRef: vi.fn(), getOwned: vi.fn() }))
const core = vi.hoisted(() => ({ host: null as string | null, directory: { status: 404, body: null as unknown } }))
const kit = vi.hoisted(() => ({ dir: '', settle: vi.fn() }))
const runtimes = vi.hoisted(() => ({ blockOf: vi.fn(async () => null as string | null), ensureUv: vi.fn(async () => undefined) }))
const registries = vi.hoisted(() => ({ list: vi.fn(() => [{ id: 'cinna-official', label: 'Cinna Official', name: 'Cinna' }]), search: vi.fn() }))

vi.mock('../mcpService', () => ({ mcpService: mcp }))
vi.mock('../agentMcpService', () => ({ agentMcpService: agentMcp }))
const access = vi.hoisted(() => ({ changeability: vi.fn(async () => 'ok') }))
vi.mock('../catalogSkillService', () => ({
  catalogSkillService: catalog,
  skillDownloadPath: () => '/dl',
  changeability: access.changeability,
  changeabilitySentence: (code: string) => `sentence:${code}`,
  locateKit: () => ({ dir: kit.dir, rootId: 'root-1' }),
  settle: kit.settle
}))
vi.mock('../cinna-http', () => ({ cinnaSend: vi.fn(async () => core.directory) }))
vi.mock('../stdioRuntimes', () => ({ stdioRuntimes: runtimes, STDIO_RUNTIME_TEXT: { uvFailed: 'Python could not be set up on this computer.', policy: 'Blocked by your admin' } }))
vi.mock('../../localdev/toolchain', () => ({ managedUvLayout: () => ({ uvBin: '/ud/uv/uv', uvxBin: '/ud/uv/uvx', env: {} }) }))
vi.mock('../catalogSkillUpdates', () => ({ activeListing: () => null }))
vi.mock('../marketplaceSkillService', () => ({ marketplaceSkillService: marketplace, snapshotDownloadPath: () => '/snap' }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: agents }))
vi.mock('../libraryService', () => ({ libraryService: { hostOf: () => core.host } }))
vi.mock('../mcpRegistryService', () => ({ mcpRegistryService: registries }))
vi.mock('../../db/mcpProviders', () => ({ mcpProviderRepo: repo }))
vi.mock('../../mcp/manager', () => ({ mcpManager: { getConnection: () => undefined, needsUser: () => false } }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => 'profile' }))

/** The skill caches: `ready` at a folder for the refs a test puts here, `missing` otherwise. */
const skillCaches = vi.hoisted(() => ({ ready: new Map<string, string>(), asked: [] as unknown[] }))
vi.mock('../catalogSkillCache', () => ({
  catalogSkillCache: {
    resolve: (ref: { packageUuid: string; revisionNumber: number; archiveSha256: string }) => {
      skillCaches.asked.push(ref)
      const dir = skillCaches.ready.get(`${ref.packageUuid}/${ref.revisionNumber}/${ref.archiveSha256}`)
      return dir ? { state: 'ready', dir } : { state: 'missing' }
    }
  }
}))
vi.mock('../marketplaceSkillCache', () => ({
  marketplaceSkillCache: {
    resolve: (ref: { entryUuid: string; archiveSha256: string }) => {
      skillCaches.asked.push(ref)
      const dir = skillCaches.ready.get(`${ref.entryUuid}/${ref.archiveSha256}`)
      return dir ? { state: 'ready', dir } : { state: 'missing' }
    }
  }
}))

const { addonDirectory, skillDashboardComponents } = await import('./index')

const USER = '__default__'
const AGENT = 'folder:a'
const REF = { source: 'mcp-registry:cinna-official', id: 'granola' }

function serves(requiresAuth: boolean): void {
  registries.search.mockResolvedValue({
    entries: [{ registryId: 'cinna-official', id: 'granola', name: 'granola', title: 'Granola', remotes: [{ type: 'streamable-http', url: 'https://g.example/mcp', requiresAuth }] }]
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  core.host = null
  runtimes.blockOf.mockResolvedValue(null)
  agents.get.mockReturnValue({ skills: [], path: '/agents/a' })
  access.changeability.mockResolvedValue('ok')
  repo.findByRegistryRef.mockReturnValue(undefined)
})

describe('addonDirectory (wired)', () => {
  it('creates the provider with its registry ref and attaches it; connected means nothing next', async () => {
    serves(false)
    mcp.createFromDirectory.mockResolvedValue({ id: 'm1', status: 'connected', needsUser: false })
    expect(await addonDirectory.add(USER, AGENT, REF)).toEqual({ ok: true, next: null, mcpProviderId: 'm1' })
    expect(mcp.createFromDirectory).toHaveBeenCalledWith(USER, {
      name: 'Granola',
      transportType: 'streamable-http',
      url: 'https://g.example/mcp',
      authType: 'oauth',
      registryRef: REF,
      connect: true
    })
    expect(agentMcp.attach).toHaveBeenCalledWith(USER, AGENT, 'm1')
  })

  it('asks for a sign-in when the server needs the user, and a Connect with the reason for any other failure', async () => {
    serves(false)
    mcp.createFromDirectory.mockResolvedValue({ id: 'm1', status: 'error', needsUser: true })
    expect(await addonDirectory.add(USER, AGENT, REF)).toMatchObject({ ok: true, next: 'oauth' })
    // Wanting auth headers is no reason to offer a token: the entry's auth is OAuth, and the server may just be down.
    serves(true)
    mcp.createFromDirectory.mockResolvedValue({ id: 'm2', status: 'error', needsUser: false, error: 'fetch failed' })
    expect(await addonDirectory.add(USER, AGENT, REF)).toEqual({ ok: true, next: 'connect', mcpProviderId: 'm2', message: 'fetch failed' })
  })

  it('deletes the connector it created when the attach is refused', async () => {
    serves(false)
    mcp.createFromDirectory.mockResolvedValue({ id: 'm1', status: 'connected', needsUser: false })
    agentMcp.attach.mockImplementationOnce(() => {
      throw Object.assign(new Error('Agent not found'), { code: 'not_found' })
    })
    expect(await addonDirectory.add(USER, AGENT, REF)).toMatchObject({ ok: false, code: 'not_found' })
    expect(mcp.delete).toHaveBeenCalledWith(USER, 'm1')
  })

  it('reads the agent’s skill access once per list, and blocks its skills with the refusal’s sentence', async () => {
    access.changeability.mockResolvedValue('read_only')
    const result = await addonDirectory.list(USER, AGENT)
    expect(result.ok).toBe(true)
    expect(access.changeability).toHaveBeenCalledTimes(1)
    expect(access.changeability).toHaveBeenCalledWith('/agents/a', null)
  })

  it('fails the access check open: a git read that throws leaves the directory readable', async () => {
    access.changeability.mockRejectedValue(new Error('git: not a repository'))
    const result = await addonDirectory.list(USER, AGENT)
    expect(result.ok).toBe(true)
  })

  it('attaches the provider already made from the entry instead of making another', async () => {
    repo.findByRegistryRef.mockReturnValue({ id: 'existing' })
    repo.list.mockReturnValue([])
    expect(await addonDirectory.add(USER, AGENT, REF)).toMatchObject({ ok: true, mcpProviderId: 'existing' })
    expect(mcp.createFromDirectory).not.toHaveBeenCalled()
    expect(agentMcp.attach).toHaveBeenCalledWith(USER, AGENT, 'existing')
  })

  it('pins a catalog skill through the catalog service and passes its refusal through', async () => {
    catalog.addToAgent.mockResolvedValue({ ok: false, code: 'not_kit_agent', message: 'Needs a cinna-agent.json.' })
    expect(await addonDirectory.add(USER, AGENT, { source: 'core-catalog', id: 'pkg' })).toEqual({
      ok: false,
      code: 'not_kit_agent',
      message: 'Needs a cinna-agent.json.'
    })
    expect(catalog.addToAgent).toHaveBeenCalledWith(USER, AGENT, 'pkg')
  })
})

describe('addonDirectory (wired) — core’s MCP directory and the manifest', () => {
  const FS = { source: 'core-mcp-directory', id: 'fs' }
  const row = (over: Record<string, unknown> = {}) => ({
    ref: FS,
    kind: 'mcp',
    name: 'filesystem',
    title: 'Filesystem',
    install: { mcp: { transport: 'stdio', url: null, package: { registry: 'npm', name: '@mcp/fs', version: '1.2.0', args: ['--ro'] }, auth: 'env', env: [{ name: 'ROOT', secret: false, description: 'Folder' }] } },
    ...over
  })
  let home: string
  // The wired core provider keeps its index for a minute: each test starts past it.
  let clock = Date.now()

  beforeEach(() => {
    clock += 10 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(clock)
    home = mkdtempSync(join(tmpdir(), 'cinna-addon-index-'))
    kit.dir = home
    writeFileSync(join(home, 'cinna-agent.json'), `${JSON.stringify({ id: 'x', slug: 'a', name: 'A' }, null, 2)}\n`)
    core.host = 'https://cinna.example'
    agents.get.mockReturnValue({ skills: [], path: home, manifest: {} })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  })

  const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(home, 'cinna-agent.json'), 'utf8'))

  it('runs an npm server through npx with its settings left to fill in, and writes the requirement without values', async () => {
    core.directory = { status: 200, body: { data: [row()], policy: {}, etag: '"1"' } }
    mcp.createFromDirectory.mockResolvedValue({ id: 'm-fs', status: 'disconnected', needsUser: false })
    repo.getOwned.mockReturnValue({ id: 'm-fs', name: 'Filesystem', transportType: 'stdio', command: 'npx', args: ['-y', '@mcp/fs@1.2.0', '--ro'], url: null, env: { ROOT: '' }, authType: 'oauth', registryRef: FS, managedBy: null })
    expect(await addonDirectory.add(USER, AGENT, FS)).toEqual({ ok: true, next: 'env', mcpProviderId: 'm-fs' })
    expect(mcp.createFromDirectory).toHaveBeenCalledWith(USER, {
      name: 'Filesystem',
      transportType: 'stdio',
      command: 'npx',
      args: ['-y', '@mcp/fs@1.2.0', '--ro'],
      env: { ROOT: '' },
      registryRef: FS,
      connect: false
    })
    expect(manifest().mcp_servers).toEqual([
      { name: 'Filesystem', ref: FS, transport: 'stdio', command: 'npx', args: ['-y', '@mcp/fs@1.2.0', '--ro'], auth: 'env', env: [{ name: 'ROOT', secret: true }] }
    ])
    expect(kit.settle).toHaveBeenCalledWith('root-1', AGENT)

    repo.findByRegistryRef.mockReturnValue({ id: 'm-fs' })
    expect(await addonDirectory.remove(USER, AGENT, FS)).toEqual({ ok: true, next: null, mcpProviderId: 'm-fs' })
    expect(manifest()).not.toHaveProperty('mcp_servers')
  })

  it('installs the managed uv for a pypi server and runs it through uvx; a failed uv refuses the add as data', async () => {
    core.directory = { status: 200, body: { data: [row({ install: { mcp: { transport: 'stdio', package: { registry: 'pypi', name: 'mcp-server-fetch', version: '1.0', args: [] }, auth: 'none', env: [] } } })] } }
    mcp.createFromDirectory.mockResolvedValue({ id: 'm-py', status: 'connected', needsUser: false })
    repo.getOwned.mockReturnValue(undefined)
    expect(await addonDirectory.add(USER, AGENT, FS)).toEqual({ ok: true, next: null, mcpProviderId: 'm-py' })
    expect(runtimes.ensureUv).toHaveBeenCalledTimes(1)
    expect(mcp.createFromDirectory).toHaveBeenLastCalledWith(USER, expect.objectContaining({ command: '/ud/uv/uvx', args: ['mcp-server-fetch==1.0'], connect: true }))

    runtimes.ensureUv.mockRejectedValueOnce(new Error('offline'))
    mcp.createFromDirectory.mockClear()
    expect(await addonDirectory.add(USER, AGENT, FS)).toEqual({ ok: false, code: 'runtime_failed', message: 'Python could not be set up on this computer.' })
    expect(mcp.createFromDirectory).not.toHaveBeenCalled()
  })

  it('refuses a server whose runtime is missing or that the admin forbids, as data, before creating anything', async () => {
    core.directory = { status: 200, body: { data: [row()], policy: { stdio_mcp: true } } }
    runtimes.blockOf.mockResolvedValue('Needs Node.js — install it from nodejs.org')
    expect(await addonDirectory.add(USER, AGENT, FS)).toEqual({ ok: false, code: 'blocked', message: 'Needs Node.js — install it from nodejs.org' })
    expect(runtimes.blockOf).toHaveBeenLastCalledWith([{ transport: 'stdio', runtime: 'node' }], expect.anything())
    expect(mcp.createFromDirectory).not.toHaveBeenCalled()
  })

  it('writes nothing for a custom connector, nor for an agent whose manifest is not the user’s', async () => {
    repo.getOwned.mockReturnValue({ id: 'custom', name: 'Mine', transportType: 'stdio', command: './s', args: null, url: null, env: null, authType: 'oauth', registryRef: null, managedBy: null })
    expect(await addonDirectory.add(USER, AGENT, { source: 'this-computer', id: 'custom' })).toMatchObject({ ok: true })
    expect(manifest()).not.toHaveProperty('mcp_servers')

    access.changeability.mockResolvedValue('read_only')
    repo.getOwned.mockReturnValue({ id: 'm-fs', name: 'Filesystem', transportType: 'stdio', command: 'npx', args: [], url: null, env: null, authType: 'oauth', registryRef: FS, managedBy: null })
    expect(await addonDirectory.add(USER, AGENT, { source: 'this-computer', id: 'm-fs' })).toMatchObject({ ok: true })
    expect(manifest()).not.toHaveProperty('mcp_servers')
  })
})


describe('skillDashboardComponents', () => {
  const SHA = 'a'.repeat(64)
  const skillEntry = (source: string, id: string, over: Record<string, unknown> = {}) => ({
    ref: { source, id }, kind: 'skill' as const, name: 'sales', title: 'Sales', summary: '', description: '', category: null, tags: [],
    iconUrl: null, publisher: null, origin: { label: 'x', kind: 'catalog' as const, repositoryUrl: null, homepage: null }, version: null,
    digest: `sha256:${SHA}`, requires: { credentials: [] }, runsCode: null, status: 'ready' as const, unsupportedReason: null, install: null, ...over
  })

  it('counts the components of the copy cached on this computer, catalog by its revision, marketplace by its digest', () => {
    const folder = mkdtempSync(join(tmpdir(), 'cinna-skill-copy-'))
    try {
      for (const name of ['deals', 'revenue']) {
        mkdirSync(join(folder, 'dashboards', name), { recursive: true })
        writeFileSync(join(folder, 'dashboards', name, 'component.json'), '{}')
      }
      skillCaches.ready.set(`pkg-1/3/${SHA}`, folder)
      skillCaches.ready.set(`entry-1/${SHA}`, folder)
      const catalog = skillEntry('core-catalog', 'pkg-1', { install: { archivePath: '/api/v1/skills/packages/pkg-1/revisions/3/download' } })
      expect(skillDashboardComponents(catalog)).toBe(2)
      expect(skillDashboardComponents(skillEntry('core-marketplace', 'entry-1'))).toBe(2)
      // Not downloaded here, no revision to look up, or no digest: nothing to count.
      expect(skillDashboardComponents(skillEntry('core-marketplace', 'entry-2'))).toBe(0)
      expect(skillDashboardComponents(skillEntry('core-catalog', 'pkg-1'))).toBe(0)
      expect(skillDashboardComponents(skillEntry('core-marketplace', 'entry-1', { digest: null }))).toBe(0)
    } finally {
      rmSync(folder, { recursive: true, force: true })
      skillCaches.ready.clear()
    }
  })
})
