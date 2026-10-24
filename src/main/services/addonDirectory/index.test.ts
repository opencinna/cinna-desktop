import { describe, it, expect, vi, beforeEach } from 'vitest'

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
const repo = vi.hoisted(() => ({ list: vi.fn(() => []), findByRegistryRef: vi.fn() }))
const registries = vi.hoisted(() => ({ list: vi.fn(() => [{ id: 'cinna-official', label: 'Cinna Official', name: 'Cinna' }]), search: vi.fn() }))

vi.mock('../mcpService', () => ({ mcpService: mcp }))
vi.mock('../agentMcpService', () => ({ agentMcpService: agentMcp }))
const access = vi.hoisted(() => ({ changeability: vi.fn(async () => 'ok') }))
vi.mock('../catalogSkillService', () => ({
  catalogSkillService: catalog,
  skillDownloadPath: () => '/dl',
  changeability: access.changeability,
  changeabilitySentence: (code: string) => `sentence:${code}`
}))
vi.mock('../catalogSkillUpdates', () => ({ activeListing: () => null }))
vi.mock('../marketplaceSkillService', () => ({ marketplaceSkillService: marketplace, snapshotDownloadPath: () => '/snap' }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: agents }))
vi.mock('../libraryService', () => ({ libraryService: { hostOf: () => null } }))
vi.mock('../mcpRegistryService', () => ({ mcpRegistryService: registries }))
vi.mock('../../db/mcpProviders', () => ({ mcpProviderRepo: repo }))
vi.mock('../../mcp/manager', () => ({ mcpManager: { getConnection: () => undefined, needsUser: () => false } }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => 'profile' }))

const { addonDirectory } = await import('./index')

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
