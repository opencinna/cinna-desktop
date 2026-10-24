import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ADDON_STATE_TEXT,
  CATALOG_SOURCE,
  LOCAL_SOURCE,
  MARKETPLACE_SOURCE,
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
      provider('cinna-core', [CATALOG_SOURCE, MARKETPLACE_SOURCE], {
        entries: [
          entry(catalogRef('aaaa')),
          entry(marketRef('BBBB')),
          entry(marketRef('pending'), { status: 'pending' }),
          entry(marketRef('broken'), { status: 'unsupported', unsupportedReason: 'no_skill_md' }),
          entry(marketRef('plugin'), { kind: 'plugin' }),
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
      ['plugin', 'blocked', 'Plugins arrive in a later update'],
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
      ['p1', 'blocked', 'Plugins arrive in a later update'],
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

  it('refuses an agent that is not a folder agent here, as data', async () => {
    agent = null
    const directory = build([])
    expect(await directory.list(USER, AGENT)).toEqual({ ok: false, code: 'not_found', message: ADDON_STATE_TEXT.agentNotFound })
    expect(await directory.add(USER, AGENT, catalogRef('c1'))).toMatchObject({ ok: false, code: 'not_found' })
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
    expect(await directory.add(USER, AGENT, registryRef('plugin'))).toMatchObject({ ok: false, code: 'blocked' })
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
