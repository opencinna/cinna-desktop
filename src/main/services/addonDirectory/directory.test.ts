import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ADDON_STATE_TEXT,
  CATALOG_SOURCE,
  CORE_MCP_SOURCE,
  LOCAL_SOURCE,
  MCP_REQUIREMENT_TEXT,
  MARKETPLACE_SOURCE,
  PLUGIN_SOURCE,
  createAddonDirectory,
  mergeLocalProviders,
  type AddonDirectoryDeps,
  type AgentFacts
} from './directory'
import type { DirectoryProvider, ProviderEntry, ProviderListing } from './types'
import type { AddonRef } from '../../../shared/addons/directory'

/**
 * The directory over fake providers: one merged list in provider order, the
 * one de-duplication (a local provider made from a directory entry), each
 * entry's state for the agent, a failing source that does not stop the
 * others, the policy gate, and Add / Remove reaching the right per-kind path.
 */

const USER = '__default__'
const AGENT = 'folder:a'

function entry(ref: AddonRef, over: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    ref,
    kind: 'skill',
    name: ref.id,
    title: ref.id,
    summary: '',
    description: '',
    category: null,
    tags: [],
    iconUrl: null,
    publisher: null,
    origin: { label: ref.source, kind: 'catalog', repositoryUrl: null, homepage: null },
    version: null,
    digest: null,
    requires: { credentials: [] },
    runsCode: null,
    status: 'ready',
    unsupportedReason: null,
    install: null,
    ...over
  }
}

const catalogRef = (id: string): AddonRef => ({ source: CATALOG_SOURCE, id })
const marketRef = (id: string): AddonRef => ({ source: MARKETPLACE_SOURCE, id })
const pluginRef = (id: string): AddonRef => ({ source: PLUGIN_SOURCE, id })
const localRef = (id: string): AddonRef => ({ source: LOCAL_SOURCE, id })
const registryRef = (id: string): AddonRef => ({ source: 'mcp-registry:cinna-official', id })

function mcpEntry(ref: AddonRef, over: Partial<ProviderEntry> = {}): ProviderEntry {
  return entry(ref, {
    kind: 'mcp',
    origin: { label: 'Cinna Official', kind: 'directory', repositoryUrl: 'https://granola.example', homepage: 'https://opencinna.io/' },
    install: { mcp: { transport: 'streamable-http', url: 'https://g.example/mcp', auth: 'oauth', requiresAuth: false } },
    ...over
  })
}

function localEntry(id: string, over: Partial<ProviderEntry> = {}): ProviderEntry {
  return entry(localRef(id), {
    kind: 'mcp',
    name: id,
    title: id,
    origin: { label: 'On this computer', kind: 'local', repositoryUrl: null, homepage: null },
    runsCode: false,
    mcpProviderId: id,
    registryRef: null,
    ...over
  })
}

function provider(
  id: string,
  sources: string[],
  listing: ProviderListing | (() => Promise<ProviderListing>),
  over: Partial<DirectoryProvider> = {}
): DirectoryProvider {
  return {
    id,
    label: id.toUpperCase(),
    owns: (ref) => sources.some((source) => ref.source === source || ref.source.startsWith(source)),
    list: vi.fn(typeof listing === 'function' ? listing : async () => listing),
    ...over
  }
}

let agent: AgentFacts | null
let attached: string[]
let skillAccess: string | null
let deps: AddonDirectoryDeps

function build(providers: DirectoryProvider[]) {
  deps = {
    providers,
    agent: vi.fn(() => agent),
    skillAccess: vi.fn(async () => skillAccess),
    attachedMcp: vi.fn(() => attached),
    addCatalogSkill: vi.fn(async () => ({ ok: true as const })),
    removeCatalogSkill: vi.fn(async () => ({ ok: true as const })),
    addMarketplaceSkill: vi.fn(async () => ({ ok: true as const })),
    removeMarketplaceSkill: vi.fn(async () => ({ ok: true as const })),
    attachMcp: vi.fn(),
    detachMcp: vi.fn(),
    mcpSetup: vi.fn(() => null),
    findMcpByRef: vi.fn(() => null),
    createMcpFromDirectory: vi.fn(async () => ({ id: 'new-mcp', setup: { next: 'oauth' as const } })),
    deleteMcp: vi.fn(async () => undefined)
  }
  return createAddonDirectory(deps)
}

beforeEach(() => {
  agent = { kit: true, skills: [] }
  attached = []
  skillAccess = null
})

const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  expect(result.ok).toBe(true)
  return result as Extract<T, { ok: true }>
}

describe('addonDirectory.list', () => {
  it('merges every provider in order, keeps two sources of the same name apart, and strips main-only fields', async () => {
    const directory = build([
      provider('cinna-core', [CATALOG_SOURCE, MARKETPLACE_SOURCE], { entries: [entry(catalogRef('c1'), { name: 'pdf' }), entry(marketRef('m1'), { name: 'pdf' })] }),
      provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [localEntry('l1')] }),
      provider('mcp-registries', ['mcp-registry:'], { entries: [mcpEntry(registryRef('granola'))] }, { gate: 'externalDirectories' })
    ])
    const result = ok(await directory.list(USER, AGENT))
    expect(result.entries.map((e) => `${e.ref.source}/${e.ref.id}`)).toEqual([
      `${CATALOG_SOURCE}/c1`,
      `${MARKETPLACE_SOURCE}/m1`,
      `${LOCAL_SOURCE}/l1`,
      'mcp-registry:cinna-official/granola'
    ])
    expect(result.sources).toEqual([
      { id: 'cinna-core', label: 'CINNA-CORE' },
      { id: LOCAL_SOURCE, label: LOCAL_SOURCE.toUpperCase() },
      { id: 'mcp-registries', label: 'MCP-REGISTRIES' }
    ])
    expect(result.policy).toEqual({ externalDirectories: true, customMcp: true, pluginHooks: true, stdioMcp: true })
    for (const e of result.entries) {
      expect(e).not.toHaveProperty('registryRef')
      expect(e).not.toHaveProperty('setupReason')
    }
    expect(result.entries[2].mcpProviderId).toBe('l1')
    // Which provider listed each entry: the picker's source select filters on it.
    expect(result.entries.map((e) => e.provider)).toEqual(['cinna-core', 'cinna-core', LOCAL_SOURCE, 'mcp-registries'])
  })

  it('says how many dashboard components a skill ships, only for skills and only when there are some', async () => {
    const directory = build([
      provider('cinna-core', [CATALOG_SOURCE, MARKETPLACE_SOURCE], {
        entries: [entry(catalogRef('c1'), { name: 'sales' }), entry(marketRef('m1'), { name: 'pdf' }), mcpEntry(registryRef('granola'))]
      })
    ])
    const counted: string[] = []
    deps.skillDashboardComponents = vi.fn((e) => {
      counted.push(e.ref.id)
      if (e.ref.id === 'm1') throw new Error('unreadable')
      return e.ref.id === 'c1' ? 2 : 5
    })
    const result = ok(await directory.list(USER, AGENT))
    expect(result.entries.map((e) => e.dashboardComponents)).toEqual([2, undefined, undefined])
    expect(result.entries[1]).not.toHaveProperty('dashboardComponents')
    // Never asked for a connector.
    expect(counted).toEqual(['c1', 'm1'])
  })

  it('passes refresh to the providers only when asked', async () => {
    const core = provider('cinna-core', [CATALOG_SOURCE], { entries: [] })
    const directory = build([core])
    await directory.list(USER, AGENT)
    expect(core.list).toHaveBeenLastCalledWith({ settingsUserId: USER })
    await directory.list(USER, AGENT, { refresh: true })
    expect(core.list).toHaveBeenLastCalledWith({ settingsUserId: USER, refresh: true })
  })

  it('blocks every skill up front on an agent whose pins are not the user’s, reading the access once', async () => {
    skillAccess = 'This agent is shared with you to use. Its skills change when the team shares a new version.'
    const directory = build([
      provider('cinna-core', [CATALOG_SOURCE, MARKETPLACE_SOURCE], { entries: [entry(catalogRef('c1')), entry(marketRef('m1')), entry(catalogRef('c2'))] }),
      provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [localEntry('l1')] })
    ])
    const states = ok(await directory.list(USER, AGENT)).entries.map((e) => [e.ref.id, e.state, e.stateReason])
    expect(states).toEqual([
      ['c1', 'blocked', skillAccess],
      ['m1', 'blocked', skillAccess],
      ['c2', 'blocked', skillAccess],
      ['l1', 'addable', null]
    ])
    expect(deps.skillAccess).toHaveBeenCalledTimes(1)
  })

  it('checks skill access only after a refreshing read has replaced the listing', async () => {
    const order: string[] = []
    const core = provider('cinna-core', [CATALOG_SOURCE], async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('listed')
      return { entries: [] }
    })
    const directory = build([core])
    ;(deps.skillAccess as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('access')
      return null
    })
    ok(await directory.list(USER, AGENT, { refresh: true }))
    expect(order).toEqual(['listed', 'access'])
  })

  it('says what an added connector still needs', async () => {
    attached = ['l1']
    const directory = build([provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [localEntry('l1', { setupReason: 'Needs you to sign in', setupStep: 'oauth' })] })])
    const [row] = ok(await directory.list(USER, AGENT)).entries
    expect([row.state, row.stateReason, row.setupStep]).toEqual(['added', 'Added — needs you to sign in', 'oauth'])
  })

  it('marks a source error that is an expired session', async () => {
    const directory = build([provider('cinna-core', [CATALOG_SOURCE], { entries: [], error: 'Expired.', errorCode: 'reauth' })])
    expect(ok(await directory.list(USER, AGENT)).sources).toEqual([{ id: 'cinna-core', label: 'CINNA-CORE', error: 'Expired.', errorCode: 'reauth' }])
  })

  it('shows a local provider made from a directory entry once, as on this computer with the entry’s metadata', async () => {
    const directory = build([
      provider(LOCAL_SOURCE, [LOCAL_SOURCE], {
        entries: [localEntry('l1', { name: 'Granola (mine)', registryRef: registryRef('granola'), setupReason: 'Needs you to sign in' }), localEntry('l2')]
      }),
      provider('mcp-registries', ['mcp-registry:'], {
        entries: [mcpEntry(registryRef('granola'), { title: 'Granola', summary: 'Meeting notes.' }), mcpEntry(registryRef('linear'))]
      })
    ])
    const result = ok(await directory.list(USER, AGENT))
    expect(result.entries.map((e) => `${e.ref.source}/${e.ref.id}`)).toEqual([
      `${LOCAL_SOURCE}/l1`,
      `${LOCAL_SOURCE}/l2`,
      'mcp-registry:cinna-official/linear'
    ])
    const merged = result.entries[0]
    expect(merged).toMatchObject({
      title: 'Granola',
      summary: 'Meeting notes.',
      origin: { label: 'On this computer', kind: 'local', repositoryUrl: 'https://granola.example', homepage: 'https://opencinna.io/' },
      install: null,
      mcpProviderId: 'l1',
      state: 'addable_with_setup',
      stateReason: 'Needs you to sign in'
    })
  })

  it('keeps a local provider whose directory entry is not listed (its source failed) with its own name', () => {
    const merged = mergeLocalProviders([localEntry('l1', { name: 'Granola', registryRef: registryRef('granola') })])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ name: 'Granola', ref: localRef('l1') })
  })

  it('marks each entry for the agent', async () => {
    agent = {
      kit: true,
      skills: [
        { source: 'catalog', name: 'pdf', packageUuid: 'AAAA' },
        { source: 'marketplace', name: 'docx', entryUuid: 'bbbb' }
      ]
    }
    attached = ['l1']
    const directory = build([
      provider('cinna-core', [CATALOG_SOURCE, MARKETPLACE_SOURCE, PLUGIN_SOURCE], {
        entries: [
          entry(catalogRef('aaaa')),
          entry(marketRef('BBBB')),
          entry(marketRef('pending'), { status: 'pending' }),
          entry(marketRef('broken'), { status: 'unsupported', unsupportedReason: 'no_skill_md' }),
          entry(pluginRef('plugin'), { kind: 'plugin' }),
          entry(catalogRef('free'))
        ]
      }),
      provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [localEntry('l1'), localEntry('l2', { setupReason: 'Needs an access token' }), localEntry('l3')] })
    ])
    const states = ok(await directory.list(USER, AGENT)).entries.map((e) => [e.ref.id, e.state, e.stateReason])
    expect(states).toEqual([
      ['aaaa', 'added', ADDON_STATE_TEXT.added],
      ['BBBB', 'added', ADDON_STATE_TEXT.added],
      ['pending', 'preparing', 'Being prepared on the server'],
      ['broken', 'blocked', ADDON_STATE_TEXT.unsupported],
      ['plugin', 'addable', null],
      ['free', 'addable', null],
      ['l1', 'added', ADDON_STATE_TEXT.added],
      ['l2', 'addable_with_setup', 'Needs an access token'],
      ['l3', 'addable', null]
    ])
  })

  it('blocks skills and plugins on a bare folder agent, and still offers connectors', async () => {
    agent = { kit: false, skills: [] }
    const directory = build([
      provider('cinna-core', [CATALOG_SOURCE], { entries: [entry(catalogRef('c1')), entry(catalogRef('p1'), { kind: 'plugin' })] }),
      provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [localEntry('l1')] })
    ])
    const states = ok(await directory.list(USER, AGENT)).entries.map((e) => [e.ref.id, e.state, e.stateReason])
    expect(states).toEqual([
      ['c1', 'blocked', 'Needs a cinna-agent.json'],
      ['p1', 'blocked', 'Needs a cinna-agent.json'],
      ['l1', 'addable', null]
    ])
  })

  it('reports a failing source and still answers the others', async () => {
    const directory = build([
      provider('cinna-core', [CATALOG_SOURCE], async () => {
        throw new Error('core is down')
      }),
      provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [localEntry('l1')] }),
      provider('mcp-registries', ['mcp-registry:'], { entries: [mcpEntry(registryRef('granola'))], error: 'Part of it failed.' })
    ])
    const result = ok(await directory.list(USER, AGENT))
    expect(result.entries.map((e) => e.ref.id)).toEqual(['l1', 'granola'])
    expect(result.sources).toEqual([
      { id: 'cinna-core', label: 'CINNA-CORE', error: 'core is down' },
      { id: LOCAL_SOURCE, label: LOCAL_SOURCE.toUpperCase() },
      { id: 'mcp-registries', label: 'MCP-REGISTRIES', error: 'Part of it failed.' }
    ])
  })

  it('does not read a gated source once core’s policy switches it off', async () => {
    const registries = provider('mcp-registries', ['mcp-registry:'], { entries: [mcpEntry(registryRef('granola'))] }, { gate: 'externalDirectories' })
    const policy = { externalDirectories: false, customMcp: true, pluginHooks: true, stdioMcp: true }
    const directory = build([provider('cinna-core', [CATALOG_SOURCE], { entries: [], policy }), registries])
    const result = ok(await directory.list(USER, AGENT))
    expect(registries.list).not.toHaveBeenCalled()
    expect(result.sources.map((s) => s.id)).toEqual(['cinna-core'])
    expect(result.policy).toEqual(policy)
    expect(await directory.add(USER, AGENT, registryRef('granola'))).toEqual({ ok: false, code: 'blocked', message: ADDON_STATE_TEXT.gated })
    expect(deps.createMcpFromDirectory).not.toHaveBeenCalled()
  })

  it('files core’s policy under the account the read started for, even when the profile switched while core answered', async () => {
    const policy = { externalDirectories: false, customMcp: false, pluginHooks: true, stdioMcp: true }
    let active = 'a@https://cinna.example'
    const set = vi.fn()
    const store = { get: () => undefined, set, account: () => active }
    const slow = provider('cinna-core', [CATALOG_SOURCE], async () => {
      active = 'b@https://cinna.example'
      return { entries: [], policy }
    })
    const directory = createAddonDirectory({ ...(build([slow]), deps), policies: store })
    await directory.list(USER, AGENT)
    expect(set).toHaveBeenCalledWith(USER, policy, 'a@https://cinna.example')
  })

  it('tells the gated sources when core’s MCP directory answered, so the index it is seeded from is not listed twice', async () => {
    const registries = provider('mcp-registries', ['mcp-registry:'], { entries: [] }, { gate: 'externalDirectories' })
    build([provider('cinna-core', [CATALOG_SOURCE], { entries: [], mcpDirectory: true }), registries])
    await createAddonDirectory(deps).list(USER, AGENT)
    expect(registries.list).toHaveBeenLastCalledWith(expect.objectContaining({ coreMcpDirectory: true }))
    const older = provider('mcp-registries', ['mcp-registry:'], { entries: [] }, { gate: 'externalDirectories' })
    await build([provider('cinna-core', [CATALOG_SOURCE], { entries: [] }), older]).list(USER, AGENT)
    expect(older.list).toHaveBeenLastCalledWith(expect.not.objectContaining({ coreMcpDirectory: true }))
  })

  it('refuses an agent that is not a folder agent here, as data', async () => {
    agent = null
    const directory = build([])
    expect(await directory.list(USER, AGENT)).toEqual({ ok: false, code: 'not_found', message: ADDON_STATE_TEXT.agentNotFound })
    expect(await directory.add(USER, AGENT, catalogRef('c1'))).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('addonDirectory plugins', () => {
  const components = (over: Partial<NonNullable<ProviderEntry['components']>> = {}): NonNullable<ProviderEntry['components']> => ({
    skills: [{ name: 's', hasScripts: false }],
    commands: [],
    agents: [],
    hooks: null,
    mcpServers: [],
    lspServers: [],
    ...over
  })

  it('marks a plugin against the agent’s engine, its pins, and what blocks it here', async () => {
    agent = { kit: true, skills: [], engine: 'codex', plugins: [{ entryUuid: 'PINNED', name: 'pinned' }] }
    attached = []
    const directory = build([
      provider('cinna-core', [PLUGIN_SOURCE], {
        entries: [
          entry(pluginRef('pinned'), { kind: 'plugin', components: components() }),
          entry(pluginRef('skills-only'), { kind: 'plugin', components: components({ mcpServers: [{ name: 'm', transport: 'http', runtime: null, auth: 'none', env: [] }] }) }),
          entry(pluginRef('partly'), { kind: 'plugin', components: components({ commands: ['c'], hooks: { events: ['PreToolUse'] } }) }),
          entry(pluginRef('none'), { kind: 'plugin', components: components({ skills: [], agents: ['a'] }) }),
          entry(pluginRef('needs-node'), { kind: 'plugin', components: components({ mcpServers: [{ name: 'n', transport: 'stdio', runtime: 'node', auth: 'none', env: [] }] }) }),
          entry(pluginRef('pending'), { kind: 'plugin', status: 'pending' })
        ]
      })
    ])
    deps.pluginBlock = vi.fn(async (_user: string, e: ProviderEntry) => (e.ref.id === 'needs-node' ? 'Needs Node.js — install it from nodejs.org' : null))
    const states = ok(await directory.list(USER, AGENT)).entries.map((e) => [e.ref.id, e.state, e.stateReason])
    expect(states).toEqual([
      ['pinned', 'added', ADDON_STATE_TEXT.added],
      ['skills-only', 'addable', null],
      ['partly', 'partly_compatible', 'Skills and commands only on Codex'],
      ['none', 'incompatible', 'Not for Codex'],
      ['needs-node', 'blocked', 'Needs Node.js — install it from nodejs.org'],
      ['pending', 'preparing', 'Being prepared on the server']
    ])
    // Asked only for a ready plugin, never for a pending one or a skill.
    expect(vi.mocked(deps.pluginBlock!).mock.calls.map((call) => call[1].ref.id)).not.toContain('pending')
  })

  it('blocks a plugin on a shared agent whose pins are not the user’s to change', async () => {
    agent = { kit: true, skills: [], engine: 'claude' }
    skillAccess = 'This agent is shared with you to use.'
    const directory = build([provider('cinna-core', [PLUGIN_SOURCE], { entries: [entry(pluginRef('p'), { kind: 'plugin', components: components() })] })])
    expect(ok(await directory.list(USER, AGENT)).entries[0]).toMatchObject({ state: 'blocked', stateReason: 'This agent is shared with you to use.' })
  })

  it('pins and unpins a plugin through its service and hands the next step back', async () => {
    agent = { kit: true, skills: [], plugins: [{ entryUuid: 'e1', name: 'carbone' }] }
    const directory = build([provider('cinna-core', [PLUGIN_SOURCE], { entries: [] })])
    deps.addPlugin = vi.fn(async () => ({ ok: true as const, next: 'env' as const }))
    deps.removePlugin = vi.fn(async () => ({ ok: true as const }))
    expect(await directory.add(USER, AGENT, pluginRef('e2'))).toEqual({ ok: true, next: 'env' })
    expect(deps.addPlugin).toHaveBeenCalledWith(USER, AGENT, 'e2')
    vi.mocked(deps.addPlugin!).mockResolvedValueOnce({ ok: false, code: 'blocked', message: 'Needs Node.js' })
    expect(await directory.add(USER, AGENT, pluginRef('e3'))).toEqual({ ok: false, code: 'blocked', message: 'Needs Node.js' })
    // The connectors its add started reach the picker, which reads "Starting…" until they are up.
    vi.mocked(deps.addPlugin!).mockResolvedValueOnce({ ok: true, next: null, starting: ['m7'] })
    expect(await directory.add(USER, AGENT, pluginRef('e4'))).toEqual({ ok: true, next: null, starting: ['m7'] })
    expect(await directory.remove(USER, AGENT, pluginRef('E1'))).toEqual({ ok: true, next: null })
    expect(deps.removePlugin).toHaveBeenCalledWith(USER, AGENT, 'carbone')
    expect(await directory.remove(USER, AGENT, pluginRef('unpinned'))).toEqual({ ok: true, next: null })
    expect(deps.removePlugin).toHaveBeenCalledTimes(1)
    expect(deps.addMarketplaceSkill).not.toHaveBeenCalled()
  })
})

describe('addonDirectory.search', () => {
  it('asks only the search providers, and shows a result made into a local provider as that provider', async () => {
    const search = vi.fn(async () => ({ entries: [mcpEntry({ source: 'mcp-registry:official', id: 'io.x/a' }), mcpEntry({ source: 'mcp-registry:official', id: 'io.x/b' })] }))
    const registries = provider('mcp-registries', ['mcp-registry:'], { entries: [] }, { search, gate: 'externalDirectories' })
    const local = provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [localEntry('l1', { registryRef: { source: 'mcp-registry:official', id: 'io.x/b' } })] })
    attached = ['l1']
    const directory = build([provider('cinna-core', [CATALOG_SOURCE], { entries: [] }), local, registries])
    const result = ok(await directory.search(USER, AGENT, 'x'))
    expect(search).toHaveBeenCalledWith({ settingsUserId: USER }, 'x')
    expect(result.entries.map((e) => [e.ref.source, e.ref.id, e.state])).toEqual([
      ['mcp-registry:official', 'io.x/a', 'addable'],
      [LOCAL_SOURCE, 'l1', 'added']
    ])
    expect(result.sources).toEqual([{ id: 'mcp-registries', label: 'MCP-REGISTRIES' }])
    expect(result.entries.map((e) => e.provider)).toEqual(['mcp-registries', LOCAL_SOURCE])

    // A searched entry can be added without searching again.
    expect(ok(await directory.add(USER, AGENT, { source: 'mcp-registry:official', id: 'io.x/a' })).next).toBe('oauth')
    expect(deps.createMcpFromDirectory).toHaveBeenCalledWith(USER, expect.objectContaining({ ref: { source: 'mcp-registry:official', id: 'io.x/a' } }))
  })
})

describe('addonDirectory.add and remove', () => {
  const core = () => provider('cinna-core', [CATALOG_SOURCE, MARKETPLACE_SOURCE], { entries: [] })
  const local = () => provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [] })

  it('pins catalog and marketplace skills through their services and hands a refusal back as it came', async () => {
    const directory = build([core(), local()])
    expect(await directory.add(USER, AGENT, catalogRef('c1'))).toEqual({ ok: true, next: null })
    expect(deps.addCatalogSkill).toHaveBeenCalledWith(USER, AGENT, 'c1')
    vi.mocked(deps.addMarketplaceSkill).mockResolvedValueOnce({ ok: false, code: 'read_only', message: 'Team agent.' })
    expect(await directory.add(USER, AGENT, marketRef('m1'))).toEqual({ ok: false, code: 'read_only', message: 'Team agent.' })
    expect(deps.addMarketplaceSkill).toHaveBeenCalledWith(USER, AGENT, 'm1')
  })

  it('unpins by the pin’s name, and treats what the agent does not pin as done', async () => {
    agent = { kit: true, skills: [{ source: 'catalog', name: 'pdf', packageUuid: 'C1' }, { source: 'marketplace', name: 'docx', entryUuid: 'm1' }] }
    const directory = build([core(), local()])
    expect(await directory.remove(USER, AGENT, catalogRef('c1'))).toEqual({ ok: true, next: null })
    expect(deps.removeCatalogSkill).toHaveBeenCalledWith(USER, AGENT, 'pdf')
    expect(await directory.remove(USER, AGENT, marketRef('M1'))).toEqual({ ok: true, next: null })
    expect(deps.removeMarketplaceSkill).toHaveBeenCalledWith(USER, AGENT, 'docx')
    expect(await directory.remove(USER, AGENT, catalogRef('not-pinned'))).toEqual({ ok: true, next: null })
    expect(deps.removeCatalogSkill).toHaveBeenCalledTimes(1)
  })

  it('attaches a local provider and says what it still needs', async () => {
    const directory = build([core(), local()])
    vi.mocked(deps.mcpSetup).mockReturnValueOnce({ next: 'bearer' })
    expect(await directory.add(USER, AGENT, localRef('l1'))).toEqual({ ok: true, next: 'bearer', mcpProviderId: 'l1' })
    expect(deps.attachMcp).toHaveBeenCalledWith(USER, AGENT, 'l1')
    expect(await directory.remove(USER, AGENT, localRef('l1'))).toEqual({ ok: true, next: null, mcpProviderId: 'l1' })
    expect(deps.detachMcp).toHaveBeenCalledWith(USER, AGENT, 'l1')

    // A connector that did not connect is never "ready": it needs a Connect, and says why.
    vi.mocked(deps.mcpSetup).mockReturnValueOnce({ next: 'connect', message: 'ECONNREFUSED' })
    expect(await directory.add(USER, AGENT, localRef('l1'))).toEqual({ ok: true, next: 'connect', mcpProviderId: 'l1', message: 'ECONNREFUSED' })
  })

  it('deletes the connector it just created when the attach fails', async () => {
    const directory = build([core(), local(), provider('mcp-registries', ['mcp-registry:'], { entries: [mcpEntry(registryRef('granola'))] })])
    vi.mocked(deps.attachMcp).mockImplementationOnce(() => {
      throw Object.assign(new Error('Agent not found'), { code: 'not_found' })
    })
    expect(await directory.add(USER, AGENT, registryRef('granola'))).toEqual({ ok: false, code: 'not_found', message: 'Agent not found' })
    expect(deps.deleteMcp).toHaveBeenCalledWith(USER, 'new-mcp')
  })

  it('does not delete an existing connector when its attach fails', async () => {
    const directory = build([core(), local()])
    vi.mocked(deps.attachMcp).mockImplementationOnce(() => {
      throw new Error('nope')
    })
    expect(await directory.add(USER, AGENT, localRef('l1'))).toMatchObject({ ok: false })
    expect(deps.deleteMcp).not.toHaveBeenCalled()
  })

  it('creates a provider from a directory entry once, then reuses it', async () => {
    const directory = build([core(), local(), provider('mcp-registries', ['mcp-registry:'], { entries: [mcpEntry(registryRef('granola'))] })])
    expect(await directory.add(USER, AGENT, registryRef('granola'))).toEqual({ ok: true, next: 'oauth', mcpProviderId: 'new-mcp' })
    expect(deps.createMcpFromDirectory).toHaveBeenCalledWith(USER, expect.objectContaining({ ref: registryRef('granola'), kind: 'mcp' }))
    expect(deps.attachMcp).toHaveBeenCalledWith(USER, AGENT, 'new-mcp')

    vi.mocked(deps.findMcpByRef).mockReturnValue('new-mcp')
    expect(await directory.add(USER, 'folder:b', registryRef('granola'))).toEqual({ ok: true, next: null, mcpProviderId: 'new-mcp' })
    expect(deps.createMcpFromDirectory).toHaveBeenCalledTimes(1)
    expect(deps.attachMcp).toHaveBeenLastCalledWith(USER, 'folder:b', 'new-mcp')

    expect(await directory.remove(USER, AGENT, registryRef('granola'))).toEqual({ ok: true, next: null, mcpProviderId: 'new-mcp' })
    expect(deps.detachMcp).toHaveBeenCalledWith(USER, AGENT, 'new-mcp')
  })

  it('refuses what cannot be added, as data, and creates nothing', async () => {
    const directory = build([
      core(),
      local(),
      provider('mcp-registries', ['mcp-registry:'], {
        entries: [
          mcpEntry(registryRef('plugin'), { kind: 'plugin' }),
          mcpEntry(registryRef('pending'), { status: 'pending' }),
          mcpEntry(registryRef('nowhere'), { install: null })
        ]
      })
    ])
    expect(await directory.add(USER, AGENT, registryRef('plugin'))).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await directory.add(USER, AGENT, registryRef('pending'))).toMatchObject({ ok: false, code: 'preparing' })
    expect(await directory.add(USER, AGENT, registryRef('nowhere'))).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await directory.add(USER, AGENT, registryRef('gone'))).toMatchObject({ ok: false, code: 'not_found' })
    expect(await directory.add(USER, AGENT, { source: 'somewhere-else', id: 'x' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(deps.createMcpFromDirectory).not.toHaveBeenCalled()
  })

  it('turns a thrown domain error into its code as data', async () => {
    const directory = build([core(), local()])
    vi.mocked(deps.attachMcp).mockImplementationOnce(() => {
      throw Object.assign(new Error('MCP provider not found'), { code: 'not_found' })
    })
    expect(await directory.add(USER, AGENT, localRef('l9'))).toEqual({ ok: false, code: 'not_found', message: 'MCP provider not found' })
  })
})

// A plain object type: it is both an AddonRef and a manifest requirement's ref.
const coreMcpRef = (id: string): { source: string; id: string } => ({ source: CORE_MCP_SOURCE, id })

function stdioEntry(id: string, registry: 'npm' | 'pypi' | 'oci' = 'npm'): ProviderEntry {
  return mcpEntry(coreMcpRef(id), {
    install: { mcp: { transport: 'stdio', package: { registry, name: id, version: '1.0.0', args: [] }, auth: 'none', requiresAuth: false, env: [] } }
  })
}

describe('addonDirectory local MCP servers from core', () => {
  it('blocks a local server the admin or this computer cannot run, and refuses its add without creating anything', async () => {
    const dir = build([provider('cinna-core', [CORE_MCP_SOURCE], { entries: [stdioEntry('fs'), stdioEntry('web')] })])
    deps.mcpBlock = vi.fn(async (_user, e: ProviderEntry) => (e.ref.id === 'fs' ? 'Blocked by your admin' : null))
    const listed = await dir.list(USER, AGENT)
    if (!listed.ok) throw new Error('refused')
    expect(listed.entries.map((e) => [e.ref.id, e.state, e.stateReason])).toEqual([
      ['fs', 'blocked', 'Blocked by your admin'],
      ['web', 'addable', null]
    ])
    expect(await dir.add(USER, AGENT, coreMcpRef('fs'))).toEqual({ ok: false, code: 'blocked', message: 'Blocked by your admin' })
    expect(deps.createMcpFromDirectory).not.toHaveBeenCalled()
    expect(await dir.add(USER, AGENT, coreMcpRef('web'))).toMatchObject({ ok: true, mcpProviderId: 'new-mcp' })
  })

  it('shows a core MCP directory server this computer already has (same URL or package) as that connector', () => {
    const merged = mergeLocalProviders([
      // Made from the opencinna list core's directory is seeded from: its ref names an entry not listed any more.
      localEntry('opencinna', { registryRef: registryRef('granola'), serverKey: 'url:https://g.example/mcp' }),
      localEntry('typed', { serverKey: 'npm:@mcp/fs' }),
      localEntry('typed-twice', { serverKey: 'npm:@mcp/fs' }),
      localEntry('other', { serverKey: 'url:https://other.example' }),
      mcpEntry(coreMcpRef('granola'), { title: 'Granola', install: { mcp: { transport: 'streamable-http', url: 'HTTPS://G.example:443/mcp/', auth: 'oauth', requiresAuth: false } } }),
      { ...stdioEntry('@mcp/fs'), title: 'File System' },
      stdioEntry('unrelated')
    ])
    expect(merged.map((e) => `${e.ref.source}/${e.ref.id}/${e.title}`)).toEqual([
      `${LOCAL_SOURCE}/opencinna/Granola`,
      `${LOCAL_SOURCE}/typed/File System`,
      `${LOCAL_SOURCE}/typed-twice/typed-twice`,
      `${LOCAL_SOURCE}/other/other`,
      `${CORE_MCP_SOURCE}/unrelated/unrelated`
    ])
    expect(merged[0]).toMatchObject({ mcpProviderId: 'opencinna', origin: { label: 'On this computer' }, install: null })
  })

  it('attaches the connector that is the same server on Add of a core MCP entry, instead of creating a second one', async () => {
    const dir = build([provider('cinna-core', [CORE_MCP_SOURCE], { entries: [stdioEntry('@mcp/fs')] })])
    deps.findMcpByServer = vi.fn(() => 'typed')
    expect(await dir.add(USER, AGENT, coreMcpRef('@mcp/fs'))).toEqual({ ok: true, next: null, mcpProviderId: 'typed' })
    expect(deps.findMcpByServer).toHaveBeenCalledWith(USER, expect.objectContaining({ ref: coreMcpRef('@mcp/fs') }))
    expect(deps.attachMcp).toHaveBeenCalledWith(USER, AGENT, 'typed')
    expect(deps.createMcpFromDirectory).not.toHaveBeenCalled()
  })

  it('never asks the MCP block of a remote server', async () => {
    const dir = build([provider('cinna-core', [CORE_MCP_SOURCE], { entries: [mcpEntry(coreMcpRef('remote'))] })])
    deps.mcpBlock = vi.fn(async () => 'nope')
    const listed = await dir.list(USER, AGENT)
    expect(listed.ok && listed.entries[0].state).toBe('addable')
    expect(deps.mcpBlock).not.toHaveBeenCalled()
  })
})

describe('addonDirectory mcp_servers[] requirements', () => {
  it('notes the requirement after an MCP add on a kit agent — new, existing or local — and never on a bare folder', async () => {
    const dir = build([provider('cinna-core', [CORE_MCP_SOURCE], { entries: [mcpEntry(coreMcpRef('gh'))] }), provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [] })])
    deps.noteMcpRequirement = vi.fn(async () => undefined)
    await dir.add(USER, AGENT, coreMcpRef('gh'))
    // Core's entry needs no auth (requiresAuth false): the requirement says none, not the OAuth-capable connector's oauth.
    expect(deps.noteMcpRequirement).toHaveBeenLastCalledWith(USER, AGENT, 'new-mcp', coreMcpRef('gh'), 'none')
    deps.findMcpByRef = vi.fn(() => 'm-existing')
    await dir.add(USER, AGENT, coreMcpRef('gh'))
    expect(deps.noteMcpRequirement).toHaveBeenLastCalledWith(USER, AGENT, 'm-existing', coreMcpRef('gh'))
    await dir.add(USER, AGENT, localRef('m-local'))
    expect(deps.noteMcpRequirement).toHaveBeenLastCalledWith(USER, AGENT, 'm-local', null)
    expect(deps.noteMcpRequirement).toHaveBeenCalledTimes(3)

    agent = { kit: false, skills: [] }
    await dir.add(USER, AGENT, localRef('m-local'))
    expect(deps.noteMcpRequirement).toHaveBeenCalledTimes(3)
  })

  it('notes the auth core states for its entry: oauth or bearer when it asks for one, a stdio entry’s own', async () => {
    const remote = (id: string, auth: 'oauth' | 'bearer') =>
      mcpEntry(coreMcpRef(id), { install: { mcp: { transport: 'streamable-http', url: `https://${id}.example/mcp`, auth, requiresAuth: true } } })
    const dir = build([provider('cinna-core', [CORE_MCP_SOURCE], { entries: [remote('signin', 'oauth'), remote('token', 'bearer'), stdioEntry('fs')] })])
    deps.noteMcpRequirement = vi.fn(async () => undefined)
    await dir.add(USER, AGENT, coreMcpRef('signin'))
    expect(deps.noteMcpRequirement).toHaveBeenLastCalledWith(USER, AGENT, 'new-mcp', coreMcpRef('signin'), 'oauth')
    await dir.add(USER, AGENT, coreMcpRef('token'))
    expect(deps.noteMcpRequirement).toHaveBeenLastCalledWith(USER, AGENT, 'new-mcp', coreMcpRef('token'), 'bearer')
    await dir.add(USER, AGENT, coreMcpRef('fs'))
    expect(deps.noteMcpRequirement).toHaveBeenLastCalledWith(USER, AGENT, 'new-mcp', coreMcpRef('fs'), 'none')
  })

  it('does not note a requirement for a skill pin or a refused add', async () => {
    const dir = build([provider('cinna-core', [CATALOG_SOURCE, CORE_MCP_SOURCE], { entries: [entry(catalogRef('pdf')), stdioEntry('fs')] })])
    deps.noteMcpRequirement = vi.fn(async () => undefined)
    deps.mcpBlock = vi.fn(async () => 'Blocked by your admin')
    await dir.add(USER, AGENT, catalogRef('pdf'))
    await dir.add(USER, AGENT, coreMcpRef('fs'))
    expect(deps.noteMcpRequirement).not.toHaveBeenCalled()
  })

  it('drops the requirement on remove, even when there is no local provider to detach', async () => {
    const dir = build([provider(LOCAL_SOURCE, [LOCAL_SOURCE], { entries: [] })])
    deps.dropMcpRequirement = vi.fn(async () => undefined)
    expect(await dir.remove(USER, AGENT, coreMcpRef('gone'))).toEqual({ ok: true, next: null })
    expect(deps.dropMcpRequirement).toHaveBeenLastCalledWith(USER, AGENT, coreMcpRef('gone'))
    await dir.remove(USER, AGENT, localRef('m1'))
    expect(deps.dropMcpRequirement).toHaveBeenLastCalledWith(USER, AGENT, localRef('m1'))
    expect(deps.detachMcp).toHaveBeenLastCalledWith(USER, AGENT, 'm1')
  })

  it('a requirement with no local provider does not make its entry added', async () => {
    agent = { kit: true, skills: [], mcpServers: [{ name: 'gh', ref: coreMcpRef('gh'), transport: 'http', url: 'https://g.example/mcp' }] }
    const dir = build([provider('cinna-core', [CORE_MCP_SOURCE], { entries: [mcpEntry(coreMcpRef('gh'))] })])
    const listed = await dir.list(USER, AGENT)
    expect(listed.ok && listed.entries[0].state).toBe('addable')
  })

  it('says where each requirement stands: a shared folder that arrived with mcp_servers[] and no providers', async () => {
    agent = {
      kit: true,
      skills: [],
      mcpServers: [
        { name: 'gh', ref: coreMcpRef('gh'), transport: 'http', url: 'https://g.example/mcp', auth: 'oauth' },
        { name: 'fs', ref: coreMcpRef('fs'), transport: 'stdio', command: 'npx', args: ['-y', 'fs@1'] },
        { name: 'gone', ref: coreMcpRef('gone'), transport: 'sse', url: 'https://x.example/sse' },
        { name: 'mine', ref: null, transport: 'stdio', command: './server' }
      ]
    }
    const dir = build([provider('cinna-core', [CORE_MCP_SOURCE], { entries: [mcpEntry(coreMcpRef('gh')), stdioEntry('fs')] })])
    const answer = await dir.mcpRequirements(USER, AGENT)
    expect(answer).toEqual({
      ok: true,
      items: [
        { name: 'gh', ref: coreMcpRef('gh'), transport: 'http', state: 'needs_setup', reason: MCP_REQUIREMENT_TEXT.needsSetup, mcpProviderId: null, entryRef: coreMcpRef('gh') },
        { name: 'fs', ref: coreMcpRef('fs'), transport: 'stdio', state: 'needs_setup', reason: MCP_REQUIREMENT_TEXT.needsSetup, mcpProviderId: null, entryRef: coreMcpRef('fs') },
        { name: 'gone', ref: coreMcpRef('gone'), transport: 'sse', state: 'unavailable', reason: 'No longer available to you', mcpProviderId: null, entryRef: null },
        { name: 'mine', ref: null, transport: 'stdio', state: 'needs_setup', reason: 'Set it up as a custom connector', mcpProviderId: null, entryRef: null }
      ]
    })
  })

  it('is ready when its local provider is attached and needs nothing; else names the step, or that it is not added', async () => {
    agent = {
      kit: true,
      skills: [],
      mcpServers: [
        { name: 'a', ref: coreMcpRef('a'), transport: 'http', url: 'https://a.example' },
        { name: 'b', ref: coreMcpRef('b'), transport: 'http', url: 'https://b.example' },
        { name: 'c', ref: coreMcpRef('c'), transport: 'http', url: 'https://c.example' }
      ]
    }
    attached = ['m-a', 'm-b']
    const dir = build([provider('cinna-core', [CORE_MCP_SOURCE], { entries: [] })])
    deps.findMcpByRef = vi.fn((_user, ref: AddonRef) => `m-${ref.id}`)
    deps.mcpSetup = vi.fn((_user, id: string) => (id === 'm-b' ? { next: 'oauth' as const } : null))
    const answer = await dir.mcpRequirements(USER, AGENT)
    if (!answer.ok) throw new Error('refused')
    expect(answer.items.map((item) => [item.name, item.state, item.reason, item.mcpProviderId, item.entryRef])).toEqual([
      ['a', 'ready', null, 'm-a', localRef('m-a')],
      ['b', 'needs_setup', 'Needs you to sign in', 'm-b', localRef('m-b')],
      ['c', 'needs_setup', MCP_REQUIREMENT_TEXT.notAttached, 'm-c', localRef('m-c')]
    ])
    // Every requirement had a provider: no source was read.
    expect(deps.providers[0].list).not.toHaveBeenCalled()
  })

  it('finds a search-only entry by ref, calls a policy-gated one unavailable, and does not call one gone while its source failed', async () => {
    agent = {
      kit: true,
      skills: [],
      mcpServers: [
        { name: 'reg', ref: { source: 'mcp-registry:official', id: 'r1' }, transport: 'http', url: 'https://r.example' },
        { name: 'core', ref: coreMcpRef('x'), transport: 'http', url: 'https://x.example' }
      ]
    }
    const registries = provider('mcp-registries', ['mcp-registry:'], { entries: [] }, {
      gate: 'externalDirectories',
      find: vi.fn(async (_ctx, ref: AddonRef) => mcpEntry(ref))
    })
    const core = provider('cinna-core', [CORE_MCP_SOURCE], { entries: [], error: 'Could not load the addons from Cinna.' })
    const dir = build([core, registries])
    let answer = await dir.mcpRequirements(USER, AGENT)
    if (!answer.ok) throw new Error('refused')
    expect(answer.items.map((item) => [item.name, item.state, item.reason, item.entryRef])).toEqual([
      ['reg', 'needs_setup', MCP_REQUIREMENT_TEXT.needsSetup, { source: 'mcp-registry:official', id: 'r1' }],
      ['core', 'needs_setup', MCP_REQUIREMENT_TEXT.unchecked, coreMcpRef('x')]
    ])

    const gatedCore = provider('cinna-core', [CORE_MCP_SOURCE], {
      entries: [],
      policy: { externalDirectories: false, customMcp: true, pluginHooks: true, stdioMcp: true }
    })
    const gatedDir = build([gatedCore, registries])
    answer = await gatedDir.mcpRequirements(USER, AGENT)
    if (!answer.ok) throw new Error('refused')
    expect(answer.items.map((item) => [item.name, item.state, item.reason])).toEqual([
      ['reg', 'unavailable', ADDON_STATE_TEXT.gated],
      ['core', 'unavailable', 'No longer available to you']
    ])
  })

  it('answers no items for a bare folder agent, and refuses an unknown agent as data', async () => {
    agent = { kit: false, skills: [], mcpServers: [{ name: 'gh', ref: coreMcpRef('gh'), transport: 'http' }] }
    const dir = build([])
    expect(await dir.mcpRequirements(USER, AGENT)).toEqual({ ok: true, items: [] })
    agent = null
    expect(await dir.mcpRequirements(USER, AGENT)).toMatchObject({ ok: false, code: 'not_found' })
  })
})
