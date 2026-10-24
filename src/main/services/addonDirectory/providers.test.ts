import type { MarketplacePluginEntry } from '../marketplacePluginService'
import { describe, it, expect, vi } from 'vitest'
import type { CatalogItem } from '../../../shared/catalogItems'
import type { MarketplaceSkillEntry } from '../../../shared/marketplaceSkills'
import type { McpRegistryEntry } from '../../../shared/mcpRegistries'
import type { McpProviderRow } from '../../db/mcpProviders'

/**
 * The three U0 providers over fake reads: what each maps a source's row to,
 * the core provider's signed-out, partial-failure and cache rules, core's own
 * snake_case shape for U4, which local providers still need a step, and the
 * registries' list-versus-search split.
 */

vi.mock('../libraryService', () => ({ libraryService: {} }))
vi.mock('../marketplaceSkillService', () => ({
  marketplaceSkillService: {},
  snapshotDownloadPath: (uuid: string, sha: string) => `/snap/${uuid}?sha256=${sha}`
}))
vi.mock('../catalogSkillService', () => ({ skillDownloadPath: (uuid: string, n: number) => `/dl/${uuid}/${n}` }))
vi.mock('../mcpRegistryService', () => ({ mcpRegistryService: {} }))
vi.mock('../../db/mcpProviders', () => ({ mcpProviderRepo: {} }))
vi.mock('../../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => 'profile' }))

const { CORE_SOURCE_TEXT, CORE_DIRECTORY_TTL_MS, catalogSkillEntry, createCinnaCoreProvider, fromCoreEntry, fromCorePolicy, marketplaceSkillEntry, summaryOf } =
  await import('./cinnaCore')
const { createThisComputerProvider, localProviderEntry, setupOf } = await import('./thisComputer')
const { stateOf } = await import('./directory')
const { createMcpRegistriesProvider, registryEntry } = await import('./mcpRegistries')
const { CinnaApiError } = await import('../../errors')

const SHA = 'a'.repeat(64)
const CTX = { settingsUserId: '__default__' }

function catalogItem(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    kind: 'skill',
    runs_on: null,
    uuid: 'pkg-1',
    id: 'acme.pdf',
    name: 'pdf',
    display_name: 'PDF tools',
    description: 'Reads PDFs. Also writes them.',
    publisher: { user_id: 'u1', display_name: 'Ada' },
    maintainers: [],
    access: 'use',
    visibility: 'public',
    is_listed: true,
    latest: { revision_number: 3, version: '1.2.0', published_at: '', published_by: null, release_notes: null },
    install_count: 0,
    my_installs: [],
    required_credential_specs: [{ slot: 'api' }],
    skills: null,
    desktop: null,
    skill: { frontmatter: {}, archive_sha256: SHA.toUpperCase(), size_bytes: 10 },
    ...over
  }
}

function marketEntry(over: Partial<MarketplaceSkillEntry> = {}): MarketplaceSkillEntry {
  return {
    entryUuid: 'entry-1',
    name: 'docx',
    description: 'Word files',
    marketplaceUuid: 'mk-1',
    marketplaceName: 'anthropics/skills',
    marketplaceOwner: 'Admin',
    repositoryUrl: 'https://github.com/anthropics/skills',
    supported: true,
    unsupportedReason: null,
    archiveSha256: SHA,
    archiveSize: 10,
    hasScripts: true,
    commitHash: null,
    version: '2',
    ...over
  }
}

describe('cinnaCore mapping', () => {
  it('maps a catalog skill package, and nothing of another kind', () => {
    expect(catalogSkillEntry(catalogItem())).toMatchObject({
      ref: { source: 'core-catalog', id: 'pkg-1' },
      kind: 'skill',
      name: 'pdf',
      title: 'PDF tools',
      summary: 'Reads PDFs.',
      publisher: { name: 'Ada', verified: false },
      origin: { label: 'Catalog', kind: 'catalog' },
      version: '1.2.0',
      digest: `sha256:${SHA}`,
      requires: { credentials: [{ slot: 'api' }] },
      runsCode: null,
      status: 'ready',
      install: { archivePath: '/dl/pkg-1/3' }
    })
    expect(catalogSkillEntry(catalogItem({ kind: 'agent' }))).toBeNull()
    expect(catalogSkillEntry(catalogItem({ latest: null }))).toMatchObject({ status: 'unsupported', install: null })
  })

  it('maps a marketplace skill, with no snapshot yet as pending and an unreadable one as unsupported', () => {
    expect(marketplaceSkillEntry(marketEntry())).toMatchObject({
      ref: { source: 'core-marketplace', id: 'entry-1' },
      origin: { label: 'anthropics/skills', kind: 'marketplace', repositoryUrl: 'https://github.com/anthropics/skills' },
      publisher: { name: 'Admin' },
      runsCode: true,
      status: 'ready',
      install: { archivePath: `/snap/entry-1?sha256=${SHA}` }
    })
    expect(marketplaceSkillEntry(marketEntry({ archiveSha256: null }))).toMatchObject({ status: 'pending', install: null })
    expect(marketplaceSkillEntry(marketEntry({ supported: false, unsupportedReason: 'no_skill_md' }))).toMatchObject({
      status: 'unsupported',
      unsupportedReason: 'no_skill_md'
    })
  })

  it('summarises to the first sentence', () => {
    expect(summaryOf('One.  Two.')).toBe('One.')
    expect(summaryOf('no stop\nat all')).toBe('no stop at all')
    expect(summaryOf(null)).toBe('')
  })

  it('reads core’s own snake_case entry and policy (U4)', () => {
    expect(
      fromCoreEntry({
        ref: { source: 'core-marketplace', id: 'e1' },
        kind: 'plugin',
        name: 'carbone',
        title: 'Carbone',
        icon_url: 'https://x/icon.png',
        origin: { label: 'claude-plugins-official', kind: 'marketplace', repository_url: 'https://r' },
        components: { skills: [{ name: 's', has_scripts: true }], mcp_servers: [{ name: 'm', transport: 'stdio', runtime: 'node', auth: 'env', env: [{ name: 'K', secret: true }] }] },
        runs_code: true,
        status: 'pending'
      })
    ).toMatchObject({
      kind: 'plugin',
      iconUrl: 'https://x/icon.png',
      origin: { repositoryUrl: 'https://r' },
      components: { skills: [{ name: 's', hasScripts: true }], mcpServers: [{ name: 'm', runtime: 'node', auth: 'env', env: [{ name: 'K', secret: true }] }] },
      runsCode: true,
      status: 'pending'
    })
    expect(fromCoreEntry({ ref: { source: 's', id: 'i' }, kind: 'agent', name: 'x' })).toBeNull()
    expect(fromCorePolicy({ external_directories: false, stdio_mcp: 'no' })).toEqual({
      externalDirectories: false,
      customMcp: true,
      pluginHooks: true,
      stdioMcp: true
    })
    expect(fromCorePolicy(null)).toEqual({ externalDirectories: true, customMcp: true, pluginHooks: true, stdioMcp: true })
  })
})

describe('cinnaCore provider', () => {
  function reads(over: Partial<Parameters<typeof createCinnaCoreProvider>[0]> = {}) {
    let now = 0
    return {
      profile: () => 'profile',
      hostOf: () => 'https://cinna.example',
      catalogItems: vi.fn(async () => [catalogItem(), catalogItem({ kind: 'agent', uuid: 'agent-1' })]),
      marketplaceSkills: vi.fn(async () => ({ ok: true as const, entries: [marketEntry()] })),
      marketplacePlugins: vi.fn(async () => ({ ok: true as const, entries: [] as MarketplacePluginEntry[] })),
      now: () => now,
      advance: (ms: number) => {
        now += ms
      },
      ...over
    }
  }

  it('lists catalog skills then marketplace skills', async () => {
    const r = reads()
    const listing = await createCinnaCoreProvider(r).list(CTX)
    expect(listing.entries.map((e) => `${e.ref.source}/${e.ref.id}`)).toEqual(['core-catalog/pkg-1', 'core-marketplace/entry-1'])
    expect(listing.error).toBeUndefined()
  })

  it('answers nothing and no error when signed out, without reading', async () => {
    const r = reads({ hostOf: () => null })
    expect(await createCinnaCoreProvider(r).list(CTX)).toEqual({ entries: [] })
    expect(r.catalogItems).not.toHaveBeenCalled()
    expect(r.marketplaceSkills).not.toHaveBeenCalled()
  })

  it('keeps the half that answered when the other fails, and says which', async () => {
    const r = reads({ catalogItems: vi.fn(async () => { throw new Error('boom') }) })
    const listing = await createCinnaCoreProvider(r).list(CTX)
    expect(listing.entries.map((e) => e.ref.id)).toEqual(['entry-1'])
    expect(listing.error).toBe(CORE_SOURCE_TEXT.catalogFailed)

    const lost = reads({
      catalogItems: vi.fn(async () => { throw new CinnaApiError('reauth_required', 'expired') }),
      marketplaceSkills: vi.fn(async () => ({ ok: false as const, code: 'reauth_required' as const, message: 'x' }))
    })
    const both = await createCinnaCoreProvider(lost).list(CTX)
    // An expired session is marked as such, so the picker can offer Sign in again.
    expect(both).toEqual({ entries: [], error: CORE_SOURCE_TEXT.reauth, errorCode: 'reauth' })
    expect(listing).not.toHaveProperty('errorCode')
  })

  it('reads the catalog from cache, and the server (past the marketplace TTL) on a refresh', async () => {
    const r = reads()
    const provider = createCinnaCoreProvider(r)
    await provider.list(CTX)
    expect(r.catalogItems).toHaveBeenLastCalledWith('profile', false)
    await provider.list(CTX)
    expect(r.marketplaceSkills).toHaveBeenCalledTimes(1)
    await provider.list({ ...CTX, refresh: true })
    expect(r.catalogItems).toHaveBeenLastCalledWith('profile', true)
    expect(r.marketplaceSkills).toHaveBeenCalledTimes(2)
  })

  it('treats the marketplace’s no_account as empty, not an error', async () => {
    const r = reads({ marketplaceSkills: vi.fn(async () => ({ ok: false as const, code: 'no_account' as const, message: 'x' })) })
    const listing = await createCinnaCoreProvider(r).list(CTX)
    expect(listing.error).toBeUndefined()
    expect(listing.entries.map((e) => e.ref.id)).toEqual(['pkg-1'])
  })

  it('reuses the marketplace list for a minute, and reads again after invalidate', async () => {
    const r = reads()
    const provider = createCinnaCoreProvider(r)
    await provider.list(CTX)
    await provider.list(CTX)
    expect(r.marketplaceSkills).toHaveBeenCalledTimes(1)
    r.advance(CORE_DIRECTORY_TTL_MS)
    await provider.list(CTX)
    expect(r.marketplaceSkills).toHaveBeenCalledTimes(2)
    provider.invalidate()
    await provider.list(CTX)
    expect(r.marketplaceSkills).toHaveBeenCalledTimes(3)
  })
})

function row(over: Partial<McpProviderRow> = {}): McpProviderRow {
  return {
    id: 'm1',
    userId: '__default__',
    name: 'Granola',
    transportType: 'streamable-http',
    command: null,
    args: null,
    url: 'https://g.example/mcp',
    env: null,
    enabled: true,
    authTokensEncrypted: null,
    clientInfo: null,
    oauthDiscoveryState: null,
    configRevision: 0,
    authType: 'oauth',
    bearerTokenEncrypted: null,
    createdBySync: false,
    registryRef: null,
    managedBy: null,
    envSecretEncrypted: null,
    managedSpec: null,
    createdAt: new Date(0),
    ...over
  }
}

describe('thisComputer provider', () => {
  it('says which local provider still needs a step', () => {
    expect(setupOf(row({ transportType: 'stdio' }), 'disconnected', true)).toBeNull()
    expect(setupOf(row(), 'connected', true)).toBeNull()
    expect(setupOf(row({ authType: 'bearer' }), 'disconnected', false)).toBe('bearer')
    expect(setupOf(row(), 'disconnected', false)).toBeNull()
    expect(setupOf(row(), 'error', true)).toBe('oauth')
    expect(setupOf(row(), 'awaiting-auth', false)).toBe('oauth')
    // A connect that failed for any other reason is never "ready": it needs a Connect.
    expect(setupOf(row({ transportType: 'stdio' }), 'error', true)).toBe('connect')
    expect(setupOf(row({ authType: 'bearer', bearerTokenEncrypted: Buffer.from('x') }), 'error', false)).toBe('connect')
    expect(setupOf(row({ authTokensEncrypted: Buffer.from('t') }), 'error', true)).toBe('connect')
    expect(setupOf(row(), 'error', false)).toBe('connect')
    // Turned off on this computer: it never connects, so turning it on comes first.
    expect(setupOf(row({ enabled: false }), 'disconnected', false)).toBe('enable')
    expect(setupOf(row({ enabled: false, authType: 'bearer' }), 'disconnected', false)).toBe('enable')
    // A server from a directory with a setting still empty needs it filled in; a hand-made one is as the user typed it.
    const stdio = { transportType: 'stdio', command: 'npx', url: null, env: { ROOT: '' } }
    expect(setupOf(row({ ...stdio, registryRef: { source: 'core-mcp-directory', id: 'fs' } }), 'disconnected', false)).toBe('env')
    expect(setupOf(row({ ...stdio, registryRef: null }), 'disconnected', false)).toBeNull()
  })

  it('says an attached connector that is turned off is added and turned off', () => {
    const off = localProviderEntry(row({ enabled: false }), 'enable')
    expect(off.setupStep).toBe('enable')
    expect(stateOf(off, { kit: true, skills: [] }, new Set(['m1']))).toEqual({ state: 'added', stateReason: 'Added — turned off' })
  })

  it('lists the scope’s providers as on this computer, with the registry ref they came from', async () => {
    const rows = vi.fn(() => [
      row({ registryRef: { source: 'mcp-registry:cinna-official', id: 'granola' } }),
      row({ id: 'm2', name: 'files', transportType: 'stdio', command: 'npx', args: ['-y', 'fs'], url: null })
    ])
    const provider = createThisComputerProvider({
      rows,
      status: (id) => (id === 'm2' ? 'error' : 'disconnected'),
      needsUser: (id) => id === 'm1',
      error: (id) => (id === 'm2' ? 'spawn npx ENOENT' : undefined)
    })
    const { entries } = await provider.list(CTX)
    expect(rows).toHaveBeenCalledWith('__default__')
    expect(entries[0]).toMatchObject({
      ref: { source: 'this-computer', id: 'm1' },
      kind: 'mcp',
      origin: { label: 'On this computer', kind: 'local' },
      summary: 'g.example',
      runsCode: false,
      mcpProviderId: 'm1',
      registryRef: { source: 'mcp-registry:cinna-official', id: 'granola' },
      setupReason: 'Needs you to sign in'
    })
    expect(entries[1]).toMatchObject({ summary: 'npx -y fs', runsCode: true, registryRef: null, setupReason: 'Could not connect' })
    expect(provider.setup('__default__', 'm1')).toEqual({ next: 'oauth' })
    expect(provider.setup('__default__', 'm2')).toEqual({ next: 'connect', message: 'spawn npx ENOENT' })
    expect(provider.setup('__default__', 'missing')).toBeNull()
  })
})

describe('mcpRegistries provider', () => {
  const info = [
    { id: 'cinna-official', label: 'Cinna Official', name: 'Cinna Official Registry', homepage: 'https://opencinna.io/' },
    { id: 'official', label: 'MCP Official', name: 'Official MCP Registry' }
  ]
  const server = (registryId: string, id: string, requiresAuth = false): McpRegistryEntry => ({
    registryId,
    id,
    name: id,
    title: `${id} title`,
    description: 'A server.',
    websiteUrl: 'https://site.example',
    remotes: [{ type: 'sse', url: `https://${id}.example/sse`, requiresAuth }]
  })

  it('lists the curated index only, searches the official registry only, and never searches an empty query', async () => {
    const search = vi.fn(async (registryId: string, query: string) =>
      registryId === 'cinna-official' ? [server('cinna-official', 'granola', true)] : [server('official', `io.x/${query}`)]
    )
    const provider = createMcpRegistriesProvider({ registries: () => info, search })
    expect(provider.gate).toBe('externalDirectories')
    const listed = await provider.list(CTX)
    expect(search).toHaveBeenLastCalledWith('cinna-official', '', 100)
    expect(listed.entries[0]).toMatchObject({
      ref: { source: 'mcp-registry:cinna-official', id: 'granola' },
      title: 'granola title',
      origin: { label: 'Cinna Official', kind: 'directory', repositoryUrl: 'https://site.example', homepage: 'https://opencinna.io/' },
      install: { mcp: { transport: 'sse', url: 'https://granola.example/sse', auth: 'oauth', requiresAuth: true } },
      setupReason: 'Needs a sign-in or an access token after adding'
    })
    const found = await provider.search!(CTX, 'pdf')
    expect(search).toHaveBeenLastCalledWith('official', 'pdf', 50)
    expect(found.entries.map((e) => e.ref)).toEqual([{ source: 'mcp-registry:official', id: 'io.x/pdf' }])
    search.mockClear()
    expect(await provider.search!(CTX, '  ')).toEqual({ entries: [] })
    expect(search).not.toHaveBeenCalled()
  })

  it('leaves the curated index out when core’s MCP directory (seeded from it) answered, and still searches the official one', async () => {
    const search = vi.fn(async (registryId: string, query: string) =>
      registryId === 'cinna-official' ? [server('cinna-official', 'granola')] : [server('official', `io.x/${query}`)]
    )
    const provider = createMcpRegistriesProvider({ registries: () => info, search })
    expect(await provider.list({ ...CTX, coreMcpDirectory: true })).toEqual({ entries: [] })
    expect(search).not.toHaveBeenCalled()
    expect((await provider.search!({ ...CTX, coreMcpDirectory: true }, 'pdf')).entries).toHaveLength(1)
    // A ref of it a connector or a requirement already names still resolves.
    expect((await provider.find!({ ...CTX, coreMcpDirectory: true }, { source: 'mcp-registry:cinna-official', id: 'granola' }))?.ref.id).toBe('granola')
  })

  it('finds one entry by ref, in either registry', async () => {
    const search = vi.fn(async (registryId: string, query: string) =>
      registryId === 'cinna-official' ? [server('cinna-official', 'granola')] : [server('official', query), server('official', `${query}-other`)]
    )
    const provider = createMcpRegistriesProvider({ registries: () => info, search })
    expect((await provider.find!(CTX, { source: 'mcp-registry:official', id: 'io.x/a' }))?.ref.id).toBe('io.x/a')
    expect((await provider.find!(CTX, { source: 'mcp-registry:cinna-official', id: 'granola' }))?.ref.id).toBe('granola')
    expect(await provider.find!(CTX, { source: 'mcp-registry:unknown', id: 'x' })).toBeNull()
    expect(provider.owns({ source: 'mcp-registry:official', id: 'x' })).toBe(true)
    expect(provider.owns({ source: 'this-computer', id: 'x' })).toBe(false)
  })

  it('drops a server with no remote it can connect to', () => {
    expect(registryEntry({ ...server('official', 'x'), remotes: [] }, undefined)).toBeNull()
  })

  it('summarises a server with no description by its host, not its URL', () => {
    expect(registryEntry({ ...server('official', 'x'), description: undefined }, undefined)?.summary).toBe('x.example')
    expect(registryEntry(server('official', 'x'), undefined)?.summary).toBe('A server.')
  })
})

describe('cinnaCore provider over core’s /addons/directory (U4)', () => {
  const POLICY = { external_directories: false, custom_mcp: true, plugin_hooks: false, stdio_mcp: true }
  const rows = [
    { ref: { source: 'core-catalog', id: 'pkg-1' }, kind: 'skill', name: 'pdf', digest: `sha256:${SHA}`, install: { archive_path: '/api/v1/catalog/pkg-1/archive' } },
    { ref: { source: 'core-catalog', id: 'agent-1' }, kind: 'plugin', name: 'not-a-skill' },
    { ref: { source: 'core-marketplace', id: 'entry-1' }, kind: 'skill', name: 'docx' },
    { ref: { source: 'core-marketplace', id: 'plug-1' }, kind: 'plugin', name: 'carbone', install: { archive_path: `/api/v1/llm-plugins/plugins/plug-1/archive?sha256=${SHA}` } },
    {
      ref: { source: 'core-mcp-directory', id: 'fs' },
      kind: 'mcp',
      name: 'filesystem',
      publisher: { name: 'Anyone', verified: false },
      install: { mcp: { transport: 'stdio', url: null, package: { registry: 'npm', name: '@mcp/fs', version: '1.2.0', args: ['--ro'] }, auth: 'env', env: [{ name: 'ROOT', secret: false, description: 'Folder' }] } }
    },
    { ref: { source: 'core-mcp-directory', id: 'gh' }, kind: 'mcp', name: 'github', install: { mcp: { transport: 'http', url: 'https://gh.example/mcp', package: null, auth: 'bearer', env: [] } } },
    { ref: { source: 'core-mcp-directory', id: 'odd' }, kind: 'mcp', name: 'odd', install: { mcp: { transport: 'stdio', package: { registry: 'cargo', name: 'x', version: '1', args: [] }, auth: 'none', env: [] } } }
  ]

  function reads(answers: Array<{ status: number; body?: unknown } | Error>) {
    let now = 0
    const directory = vi.fn(async (_profile: string, _etag: string | null) => {
      const next = answers.shift()
      if (!next) throw new Error('no more answers')
      if (next instanceof Error) throw next
      return { status: next.status, body: next.body ?? null }
    })
    return {
      profile: () => 'profile',
      hostOf: () => 'https://cinna.example',
      catalogItems: vi.fn(async () => [catalogItem()]),
      marketplaceSkills: vi.fn(async () => ({ ok: true as const, entries: [marketEntry()] })),
      marketplacePlugins: vi.fn(async () => ({ ok: true as const, entries: [] as MarketplacePluginEntry[] })),
      directory,
      now: () => now,
      advance: (ms: number) => {
        now += ms
      }
    }
  }

  it('maps the whole index and its policy in one read, with the refs the older reads produced', async () => {
    const r = reads([{ status: 200, body: { data: rows, count: rows.length, policy: POLICY, etag: '"v1"' } }])
    const listing = await createCinnaCoreProvider(r).list(CTX)
    expect(listing.entries.map((e) => `${e.ref.source}/${e.ref.id}`)).toEqual([
      'core-catalog/pkg-1',
      'core-marketplace/entry-1',
      // A marketplace plugin is pinned by its own service: the same ref the discover path gives it.
      'core-marketplace-plugin/plug-1',
      'core-mcp-directory/fs',
      'core-mcp-directory/gh',
      'core-mcp-directory/odd'
    ])
    expect(listing.policy).toEqual({ externalDirectories: false, customMcp: true, pluginHooks: false, stdioMcp: true })
    // Core's MCP directory answered: the registries provider leaves out the index it is seeded from.
    expect(listing.mcpDirectory).toBe(true)
    expect(r.catalogItems).not.toHaveBeenCalled()
    expect(r.marketplaceSkills).not.toHaveBeenCalled()
    const byId = new Map(listing.entries.map((e) => [e.ref.id, e]))
    expect(byId.get('fs')).toMatchObject({
      status: 'ready',
      publisher: { name: 'Anyone', verified: false },
      install: { mcp: { transport: 'stdio', package: { registry: 'npm', name: '@mcp/fs', version: '1.2.0', args: ['--ro'] }, auth: 'env', env: [{ name: 'ROOT', secret: false, description: 'Folder' }] } },
      setupReason: CORE_SOURCE_TEXT.needsEnv
    })
    expect(byId.get('gh')).toMatchObject({
      install: { mcp: { transport: 'streamable-http', url: 'https://gh.example/mcp', auth: 'bearer', requiresAuth: true } },
      setupReason: CORE_SOURCE_TEXT.needsAuth
    })
    // A package registry this build cannot run is listed, but not addable.
    expect(byId.get('odd')).toMatchObject({ status: 'unsupported', install: null })
    expect(byId.get('pkg-1')).toMatchObject({ digest: `sha256:${SHA}`, install: { archivePath: '/api/v1/catalog/pkg-1/archive' } })
  })

  it('asks again with If-None-Match after the TTL or on a refresh, and reuses the cached index on a 304', async () => {
    const r = reads([
      { status: 200, body: { data: rows.slice(0, 1), policy: POLICY, etag: '"v1"' } },
      { status: 304 },
      { status: 304 }
    ])
    const provider = createCinnaCoreProvider(r)
    const first = await provider.list(CTX)
    expect(r.directory).toHaveBeenLastCalledWith('profile', null)
    await provider.list(CTX)
    expect(r.directory).toHaveBeenCalledTimes(1)
    r.advance(CORE_DIRECTORY_TTL_MS)
    const second = await provider.list(CTX)
    expect(r.directory).toHaveBeenLastCalledWith('profile', '"v1"')
    expect(second.entries).toEqual(first.entries)
    expect(second.policy).toEqual(first.policy)
    const third = await provider.list({ ...CTX, refresh: true })
    expect(r.directory).toHaveBeenCalledTimes(3)
    expect(third.entries.map((e) => e.ref.id)).toEqual(['pkg-1'])
  })

  it('falls back to the catalog and marketplace reads on a 404, with no policy (the stored one stands), until a refresh', async () => {
    const r = reads([{ status: 404 }, { status: 404 }])
    const provider = createCinnaCoreProvider(r)
    const listing = await provider.list(CTX)
    expect(listing.entries.map((e) => `${e.ref.source}/${e.ref.id}`)).toEqual(['core-catalog/pkg-1', 'core-marketplace/entry-1'])
    expect(listing).not.toHaveProperty('policy')
    // An older core has no MCP directory: the Cinna registry index is still listed.
    expect(listing).not.toHaveProperty('mcpDirectory')
    r.advance(CORE_DIRECTORY_TTL_MS)
    await provider.list(CTX)
    expect(r.directory).toHaveBeenCalledTimes(1)
    await provider.list({ ...CTX, refresh: true })
    expect(r.directory).toHaveBeenCalledTimes(2)
  })

  it('keeps the last index but sends no policy when the read fails, and marks an expired session', async () => {
    const r = reads([{ status: 200, body: { data: rows.slice(0, 1), policy: POLICY, etag: '"v1"' } }, new Error('offline'), { status: 500 }])
    const provider = createCinnaCoreProvider(r)
    await provider.list(CTX)
    const failed = await provider.list({ ...CTX, refresh: true })
    expect(failed).toEqual({ entries: expect.any(Array), error: CORE_SOURCE_TEXT.directoryFailed, mcpDirectory: true })
    expect(failed.entries.map((e) => e.ref.id)).toEqual(['pkg-1'])
    expect(failed).not.toHaveProperty('policy')
    expect(await provider.list({ ...CTX, refresh: true })).not.toHaveProperty('policy')

    const expired = reads([new CinnaApiError('reauth_required', 'Cinna 401')])
    expect(await createCinnaCoreProvider(expired).list(CTX)).toEqual({ entries: [], error: CORE_SOURCE_TEXT.reauth, errorCode: 'reauth' })
  })

  it('answers nothing when signed out, without asking the directory', async () => {
    const r = { ...reads([]), hostOf: () => null }
    expect(await createCinnaCoreProvider(r).list(CTX)).toEqual({ entries: [] })
    expect(r.directory).not.toHaveBeenCalled()
  })

  it('owns core’s MCP directory refs', () => {
    expect(createCinnaCoreProvider(reads([])).owns({ source: 'core-mcp-directory', id: 'x' })).toBe(true)
  })
})
