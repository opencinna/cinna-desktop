import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * Cloud tiles in the dashboards service (D6.1, D6.8, D6.9) over the real
 * migration chain and repository, with core's client scripted: adding a tile
 * (backing dashboard, block, limits, refusals), keeping core in step, how a
 * tile reads from what main last fetched, placements, the components list
 * and references.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent' }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: [] }) } }))
vi.mock('../cinna-http', () => ({ cinnaSend: vi.fn(async () => { throw new Error('no network in tests') }), resolveBaseUrl: () => 'https://cinna.example.com' }))

const { createDashboardService } = await import('./dashboardService')
const { createBackingDashboards } = await import('./remote/backingDashboards')
const { dashboardRepo } = await import('../../db/dashboards')
type CloudAgent = import('./remote/cloudComponent').CloudAgent
type CoreComponent = import('./remote/coreDashboardsClient').CoreComponent

const SERVER = 'https://cinna.example.com'
const ok = <T,>(value: T) => ({ ok: true as const, value })
const refusal = (code: string, status: number | null = null, message = '') => ({ ok: false as const, code: code as never, message, status })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const deals = {
  schema_version: 1, title: 'Open deals', view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } },
  size: 'l', params: { month: { type: 'month', default: 'current' } }, refresh: { while_open_every: '5m' }
}
const component = (overrides: Partial<CoreComponent> = {}): CoreComponent => ({
  name: 'deals', skill: null, title: 'Open deals', view: 'list', component_json: deals, findings: [], has_errors: false, size_bytes: 100, placements: [], ...overrides
})

let server: string | null
let cloudAgents: CloudAgent[]
let client: Record<string, ReturnType<typeof vi.fn>>
let published: string[]
let clock: number
let backing: ReturnType<typeof createBackingDashboards>
let service: ReturnType<typeof createDashboardService>

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('p1', 'cinna_user', 'p1', 'P1', 1);`)
  server = SERVER
  clock = 1_000_000
  published = []
  cloudAgents = [
    { id: 'remote:a', name: 'Ops Bot', remoteTargetId: 'core-a', owned: true, bundleId: 'io.example.ops' },
    { id: 'remote:b', name: 'Shared Bot', remoteTargetId: 'core-b', owned: false, bundleId: 'io.example.shared' }
  ]
  let blocks = 0
  client = {
    getComponent: vi.fn(async () => ok(component())),
    listComponents: vi.fn(async () => ok({ components: [component()] })),
    addBlock: vi.fn(async () => ok({ id: `blk-${++blocks}`, agent_id: 'core-a', view_type: 'agent_component', title: null, config: null })),
    deleteBlock: vi.fn(async () => ok({})),
    createDashboard: vi.fn(async (_u: string, name: string) => ok({ id: 'core-d1', name, blocks: [] })),
    getDashboard: vi.fn(async () => ok({ id: 'core-d1', name: 'Ops', blocks: [] })),
    renameDashboard: vi.fn(async () => ok({})),
    deleteDashboard: vi.fn(async () => ok({})),
    updateBlock: vi.fn(async () => ok({}))
  }
  backing = createBackingDashboards({ client: client as never, serverUrl: () => server })
  service = createDashboardService({
    agents: () => [],
    cloud: { agents: () => cloudAgents, serverUrl: () => server, client: client as never, backing, publish: (id) => published.push(id), now: () => clock }
  })
})
afterEach(() => {
  holder.current?.close()
})

async function addOps(input: Record<string, unknown> = {}) {
  const out = await service.addCloudTile('p1', { newDashboardName: 'Ops', agentId: 'remote:a', component: 'deals', ...input })
  if (!out.ok) throw new Error(out.message)
  return out
}

describe('adding a cloud tile', () => {
  it('makes the backing core dashboard once, adds a block, and stores a remote row that reads as ok', async () => {
    const first = await addOps()
    expect(client.getComponent).toHaveBeenCalledWith('p1', 'core-a', 'deals', null)
    expect(client.createDashboard).toHaveBeenCalledWith('p1', 'Ops')
    expect(client.addBlock).toHaveBeenCalledWith('p1', 'core-d1', {
      agentId: 'core-a', title: null, gridW: 6, gridH: 4, config: { component: 'deals', skill: null, params: {}, refresh: {} }
    })
    expect(first.tile).toMatchObject({ agentManifestId: '', component: 'deals', size: 'l', params: {}, cloud: { remoteAgentId: 'core-a', server: 'cinna.example.com' } })
    const row = dashboardRepo.tile('p1', first.tile.id)!
    expect(row).toMatchObject({ source: 'remote', remoteAgentId: 'core-a', coreBlockId: 'blk-1' })
    expect(dashboardRepo.get('p1', first.dashboard.id)).toMatchObject({ coreDashboardId: 'core-d1', coreServer: SERVER })

    const listed = service.tiles('p1', first.dashboard.id)
    if (!listed.ok) throw new Error()
    expect(listed.tiles[0]).toMatchObject({
      state: 'ok', displayTitle: 'Open deals', agentName: 'Ops Bot', schedule: null,
      component: { agentId: 'remote:a', manifestId: '', valid: true, view: 'list', params: { month: { type: 'month' } }, refresh: { whileOpenEvery: '5m' }, cloud: { remoteAgentId: 'core-a' } }
    })
    // No core id, block or URL reaches the renderer.
    expect(JSON.stringify(listed)).not.toMatch(/core-d1|blk-1|https:/)

    // A second tile on the same dashboard: the backing one is checked, not made again; its drifted name is set again.
    client.getDashboard.mockResolvedValueOnce(ok({ id: 'core-d1', name: 'Old name', blocks: [] }))
    const second = await service.addCloudTile('p1', { dashboardId: first.dashboard.id, agentId: 'remote:a', component: 'deals', title: 'Mine', size: 's', refreshOverride: { maxAge: '1h' } })
    expect(second.ok).toBe(true)
    expect(client.createDashboard).toHaveBeenCalledTimes(1)
    expect(client.addBlock).toHaveBeenLastCalledWith('p1', 'core-d1', expect.objectContaining({ title: 'Mine', gridW: 3, gridH: 2, config: expect.objectContaining({ refresh: { max_age: '1h' } }) }))
    await backing.settled()
    expect(client.renameDashboard).toHaveBeenCalledWith('p1', 'core-d1', 'Ops')
  })

  it('refuses an agent the profile does not own, an invalid component and a missing one, leaving no dashboard behind', async () => {
    expect(await service.addCloudTile('p1', { newDashboardName: 'X', agentId: 'remote:b', component: 'deals' })).toEqual({
      ok: false, code: 'not_owner', message: 'Only Shared Bot’s owner can add its components to a dashboard.'
    })
    expect(client.getComponent).not.toHaveBeenCalled()
    client.getComponent.mockResolvedValueOnce(ok(component({ has_errors: true })))
    expect(await service.addCloudTile('p1', { newDashboardName: 'X', agentId: 'remote:a', component: 'deals' })).toMatchObject({ ok: false, code: 'component_invalid' })
    client.getComponent.mockResolvedValueOnce(refusal('not_found', 404))
    expect(await service.addCloudTile('p1', { newDashboardName: 'X', agentId: 'remote:a', component: 'deals' })).toMatchObject({ ok: false, code: 'not_found', message: 'That component is no longer in Ops Bot.' })
    client.getComponent.mockResolvedValueOnce(refusal('unreachable'))
    expect(await service.addCloudTile('p1', { newDashboardName: 'X', agentId: 'remote:a', component: 'deals' })).toMatchObject({ ok: false, code: 'unreachable', message: 'Can’t reach cinna.example.com.' })
    // A core refusal after the dashboard was made here takes it away again.
    client.createDashboard.mockResolvedValueOnce(refusal('limit_reached', 409, 'Maximum of 50 Cinna Desktop dashboards allowed per user'))
    expect(await service.addCloudTile('p1', { newDashboardName: 'X', agentId: 'remote:a', component: 'deals' })).toEqual({
      ok: false, code: 'limit_reached', message: 'cinna.example.com holds no more dashboards with cloud tiles for you. Delete a dashboard that has cloud tiles, or add this to one of them.'
    })
    expect(service.list('p1')).toEqual([])
  })

  it('holds at most 20 cloud tiles per dashboard', async () => {
    const first = await addOps()
    for (let i = 0; i < 19; i++) await service.addCloudTile('p1', { dashboardId: first.dashboard.id, agentId: 'remote:a', component: 'deals' })
    const calls = client.addBlock.mock.calls.length
    expect(await service.addCloudTile('p1', { dashboardId: first.dashboard.id, agentId: 'remote:a', component: 'deals' })).toEqual({
      ok: false, code: 'limit_reached', message: 'A dashboard holds at most 20 cloud tiles.'
    })
    expect(client.addBlock).toHaveBeenCalledTimes(calls)
    // Core's own 409 for its 20-block cap reads the same, should it come back first.
    const other = await addOps({ newDashboardName: 'Other' })
    client.addBlock.mockResolvedValueOnce(refusal('limit_reached', 409, 'Maximum of 20 blocks allowed per dashboard'))
    expect(await service.addCloudTile('p1', { dashboardId: other.dashboard.id, agentId: 'remote:a', component: 'deals' })).toEqual({
      ok: false, code: 'limit_reached', message: 'A dashboard holds at most 20 cloud tiles.'
    })
  })

  it('makes the backing dashboard again once when core says the recorded one is gone', async () => {
    const first = await addOps()
    client.getDashboard.mockResolvedValueOnce(refusal('not_found', 404))
    client.createDashboard.mockResolvedValueOnce(ok({ id: 'core-d2', name: 'Ops', blocks: [] }))
    expect((await service.addCloudTile('p1', { dashboardId: first.dashboard.id, agentId: 'remote:a', component: 'deals' })).ok).toBe(true)
    expect(dashboardRepo.get('p1', first.dashboard.id)?.coreDashboardId).toBe('core-d2')
    expect(client.addBlock).toHaveBeenLastCalledWith('p1', 'core-d2', expect.anything())
  })

  it('deletes the backing core dashboard it made when an add to a new dashboard fails after it', async () => {
    client.addBlock.mockResolvedValueOnce(refusal('env_unavailable', 503, 'The environment is starting; try again in a moment.'))
    expect(await service.addCloudTile('p1', { newDashboardName: 'Ops', agentId: 'remote:a', component: 'deals' })).toMatchObject({ ok: false, code: 'env_unavailable' })
    await backing.settled()
    expect(client.deleteDashboard).toHaveBeenCalledWith('p1', 'core-d1')
    expect(service.list('p1')).toEqual([])
    // An add to a dashboard that was there before keeps its backing dashboard.
    const first = await addOps()
    client.deleteDashboard.mockClear()
    client.addBlock.mockResolvedValueOnce(refusal('unreachable'))
    expect(await service.addCloudTile('p1', { dashboardId: first.dashboard.id, agentId: 'remote:a', component: 'deals' })).toMatchObject({ ok: false, code: 'unreachable' })
    await backing.settled()
    expect(client.deleteDashboard).not.toHaveBeenCalled()
  })

  it('clears blocks whose delete never reached core when core’s 20-block cap is hit, then adds once more', async () => {
    const first = await addOps()
    client.addBlock.mockResolvedValueOnce(refusal('limit_reached', 409, 'Maximum of 20 blocks allowed per dashboard'))
    // The first read is `ensure` checking the backing dashboard; the second the orphan sweep.
    client.getDashboard.mockResolvedValueOnce(ok({ id: 'core-d1', name: 'Ops', blocks: [] }))
    client.getDashboard.mockResolvedValueOnce(ok({
      id: 'core-d1', name: 'Ops',
      blocks: [
        { id: 'blk-1', agent_id: 'core-a', view_type: 'agent_component', title: null, config: null },
        { id: 'blk-orphan', agent_id: 'core-a', view_type: 'agent_component', title: null, config: null }
      ]
    }))
    const again = await service.addCloudTile('p1', { dashboardId: first.dashboard.id, agentId: 'remote:a', component: 'deals' })
    expect(again.ok).toBe(true)
    expect(client.deleteBlock).toHaveBeenCalledWith('p1', 'core-d1', 'blk-orphan')
    expect(client.deleteBlock).not.toHaveBeenCalledWith('p1', 'core-d1', 'blk-1')
    // With nothing to clear, core's cap is the answer.
    client.addBlock.mockResolvedValueOnce(refusal('limit_reached', 409, 'Maximum of 20 blocks allowed per dashboard'))
    client.getDashboard.mockResolvedValueOnce(ok({ id: 'core-d1', name: 'Ops', blocks: [] }))
    client.getDashboard.mockResolvedValueOnce(ok({ id: 'core-d1', name: 'Ops', blocks: [] }))
    const calls = client.addBlock.mock.calls.length
    expect(await service.addCloudTile('p1', { dashboardId: first.dashboard.id, agentId: 'remote:a', component: 'deals' })).toMatchObject({ ok: false, code: 'limit_reached' })
    expect(client.addBlock).toHaveBeenCalledTimes(calls + 1)
  })

  it('deletes the block again when the row cannot be written', async () => {
    const spy = vi.spyOn(dashboardRepo, 'addTile').mockImplementationOnce(() => { throw new Error('disk full') })
    expect(await service.addCloudTile('p1', { newDashboardName: 'Ops', agentId: 'remote:a', component: 'deals' })).toMatchObject({ ok: false })
    await tick()
    expect(client.deleteBlock).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1')
    spy.mockRestore()
  })

  it('reads a dashboard made on another server as Not on this server, refuses adds to it and sends it nothing', async () => {
    const first = await addOps()
    server = 'https://other.example.org'
    const listed = service.tiles('p1', first.dashboard.id)
    expect(listed.ok && listed.tiles[0].state).toBe('wrong_server')
    expect(await service.addCloudTile('p1', { dashboardId: first.dashboard.id, agentId: 'remote:a', component: 'deals' })).toMatchObject({ ok: false, code: 'wrong_server' })
    service.rename('p1', first.dashboard.id, 'Renamed')
    service.removeTile('p1', first.tile.id)
    await backing.settled()
    expect(client.renameDashboard).not.toHaveBeenCalled()
    expect(client.deleteBlock).not.toHaveBeenCalled()
  })
})

describe('keeping core in step (D6.1)', () => {
  it('renames, retitles, sends refresh overrides with the block’s params, removes and deletes, without waiting', async () => {
    const first = await addOps()
    await backing.settled()
    client.renameDashboard.mockClear()
    expect(service.rename('p1', first.dashboard.id, 'Pipeline')).toMatchObject({ ok: true })
    expect(service.updateTile('p1', { tileId: first.tile.id, title: 'My deals' })).toMatchObject({ ok: true, tile: { title: 'My deals', cloud: { remoteAgentId: 'core-a' } } })
    client.getDashboard.mockResolvedValueOnce(ok({
      id: 'core-d1', name: 'Pipeline',
      blocks: [{ id: 'blk-1', agent_id: 'core-a', view_type: 'agent_component', title: 'My deals', config: { component: 'deals', skill: null, params: { month: '2026-01' }, refresh: {} } }]
    }))
    service.updateTile('p1', { tileId: first.tile.id, refreshOverride: { maxAge: '1h', whileOpenEvery: null, afterTurn: true, manual: true, onAppStart: true } })
    await backing.settled()
    expect(client.renameDashboard).toHaveBeenCalledWith('p1', 'core-d1', 'Pipeline')
    expect(client.updateBlock).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', { title: 'My deals' })
    // Core replaces the whole config: the params the owner set stay; Manual and on-app-start stay on the desktop.
    expect(client.updateBlock).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', {
      config: { component: 'deals', skill: null, params: { month: '2026-01' }, refresh: { max_age: '1h', while_open_every: 'manual', after_turn: true } }
    })

    client.deleteBlock.mockResolvedValueOnce(refusal('unreachable'))
    expect(service.removeTile('p1', first.tile.id)).toEqual({ ok: true })
    expect(service.delete('p1', first.dashboard.id)).toEqual({ ok: true })
    await backing.settled()
    expect(client.deleteBlock).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1')
    expect(client.deleteDashboard).toHaveBeenCalledWith('p1', 'core-d1')
  })

  it('never fails a local change because core is unreachable', async () => {
    const first = await addOps()
    for (const fn of Object.values(client)) fn.mockResolvedValue(refusal('unreachable'))
    expect(service.rename('p1', first.dashboard.id, 'Offline')).toMatchObject({ ok: true, dashboard: { name: 'Offline' } })
    expect(service.updateTile('p1', { tileId: first.tile.id, title: 'T' })).toMatchObject({ ok: true })
    expect(service.removeTile('p1', first.tile.id)).toEqual({ ok: true })
    await backing.settled()
  })

  it('keeps a refresh change core refused pending and sends it again after the tile’s next refresh, a few times at most', async () => {
    const first = await addOps()
    await backing.settled()
    const withBlock = ok({ id: 'core-d1', name: 'Ops', blocks: [{ id: 'blk-1', agent_id: 'core-a', view_type: 'agent_component', title: null, config: { component: 'deals', skill: null, params: {}, refresh: {} } }] })
    client.getDashboard.mockResolvedValue(withBlock)
    client.updateBlock.mockResolvedValue(refusal('invalid_input', 400, 'The environment is not running.'))
    service.updateTile('p1', { tileId: first.tile.id, refreshOverride: { maxAge: '1h' } })
    await backing.settled()
    expect(client.updateBlock).toHaveBeenCalledTimes(1)
    expect(backing.hasPendingRefresh(first.tile.id)).toBe(true)
    // The environment ran a refresh: sent again, still refused.
    service.cloudRefreshed('p1', first.tile.id)
    await backing.settled()
    expect(client.updateBlock).toHaveBeenCalledTimes(2)
    service.cloudRefreshed('p1', first.tile.id)
    await backing.settled()
    expect(client.updateBlock).toHaveBeenCalledTimes(3)
    // Given up after that.
    service.cloudRefreshed('p1', first.tile.id)
    await backing.settled()
    expect(client.updateBlock).toHaveBeenCalledTimes(3)
    expect(backing.hasPendingRefresh(first.tile.id)).toBe(false)
    // A change that gets through clears it; a refresh then sends nothing.
    client.updateBlock.mockResolvedValue(ok({}))
    service.updateTile('p1', { tileId: first.tile.id, refreshOverride: { maxAge: '2h' } })
    await backing.settled()
    expect(backing.hasPendingRefresh(first.tile.id)).toBe(false)
    const sent = client.updateBlock.mock.calls.length
    service.cloudRefreshed('p1', first.tile.id)
    await backing.settled()
    expect(client.updateBlock).toHaveBeenCalledTimes(sent)
    // Unreachable core keeps it pending too.
    client.getDashboard.mockResolvedValueOnce(refusal('unreachable'))
    service.updateTile('p1', { tileId: first.tile.id, refreshOverride: { maxAge: '3h' } })
    await backing.settled()
    expect(backing.hasPendingRefresh(first.tile.id)).toBe(true)
    service.cloudRefreshed('p1', first.tile.id)
    await backing.settled()
    expect(client.updateBlock).toHaveBeenLastCalledWith('p1', 'core-d1', 'blk-1', { config: expect.objectContaining({ refresh: { max_age: '3h' } }) })
    expect(backing.hasPendingRefresh(first.tile.id)).toBe(false)
  })

  it('writes the params again when a params change landed between the refresh change’s read and its write', async () => {
    const first = await addOps()
    await backing.settled()
    client.getDashboard.mockResolvedValue(ok({
      id: 'core-d1', name: 'Ops',
      blocks: [{ id: 'blk-1', agent_id: 'core-a', view_type: 'agent_component', title: null, config: { component: 'deals', skill: null, params: { month: '2026-01' }, refresh: {} } }]
    }))
    client.updateBlock.mockImplementationOnce(async () => {
      // The owner's filter (or core's event for the agent's change) lands while the write is on its way.
      dashboardRepo.updateTile('p1', first.tile.id, { paramsJson: JSON.stringify({ month: '2026-03' }) })
      return ok({})
    })
    service.updateTile('p1', { tileId: first.tile.id, refreshOverride: { maxAge: '1h' } })
    await backing.settled()
    expect(client.updateBlock).toHaveBeenCalledTimes(2)
    expect(client.updateBlock).toHaveBeenLastCalledWith('p1', 'core-d1', 'blk-1', {
      config: { component: 'deals', skill: null, params: { month: '2026-03' }, refresh: { max_age: '1h' } }
    })
    // Nothing landed meanwhile: one write.
    client.updateBlock.mockClear()
    service.updateTile('p1', { tileId: first.tile.id, refreshOverride: { maxAge: '2h' } })
    await backing.settled()
    expect(client.updateBlock).toHaveBeenCalledTimes(1)
  })
})

describe('a cloud tile as main last read it', () => {
  it('reads the agent’s list again behind tiles(), at most once a minute, and follows a changed, missing or gone component', async () => {
    const first = await addOps()
    const dashboardId = first.dashboard.id
    const state = () => {
      const listed = service.tiles('p1', dashboardId)
      return listed.ok ? listed.tiles[0] : null
    }
    client.listComponents.mockResolvedValueOnce(ok({ components: [component({ title: 'Deals renamed', component_json: { ...deals, title: 'Deals renamed' } })] }))
    state()
    state()
    await tick()
    expect(client.listComponents).toHaveBeenCalledTimes(1)
    expect(published).toEqual([first.tile.id])
    expect(state()?.displayTitle).toBe('Deals renamed')

    clock += 61_000
    client.listComponents.mockResolvedValueOnce(ok({ components: [] }))
    state()
    await tick()
    expect(state()?.state).toBe('component_missing')

    clock += 61_000
    client.listComponents.mockResolvedValueOnce(refusal('not_found', 404))
    state()
    await tick()
    expect(state()).toMatchObject({ state: 'agent_missing', agentName: 'Ops Bot' })

    // The agent left the synced list: gone, still named from the stored component (D6.10 "<agent> is no longer available.").
    cloudAgents = cloudAgents.filter((agent) => agent.id !== 'remote:a')
    expect(state()).toMatchObject({ state: 'agent_missing', agentName: 'Ops Bot', component: null })
  })

  it('places a cloud agent’s tiles by its row id; its folder components are none; its cloud list comes with placements', async () => {
    const first = await addOps()
    expect(service.placements('p1', 'remote:a')).toEqual([{ component: 'deals', skill: null, tileId: first.tile.id, dashboardId: first.dashboard.id, dashboardName: 'Ops' }])
    expect(service.components('remote:a')).toEqual([])
    const listed = await service.cloudComponents('p1', 'remote:a')
    client.listComponents.mockResolvedValueOnce(ok({ components: [component({ placements: [{ dashboard_id: 'core-d1', dashboard_name: 'Ops', block_id: 'blk-1', origin: 'desktop' }, { dashboard_id: 'web-1', dashboard_name: 'Web board', block_id: 'b9', origin: 'web' }] })] }))
    const withCore = await service.cloudComponents('p1', 'remote:a')
    expect(withCore.ok && withCore.placements).toEqual([{ component: 'deals', skill: null, tileId: first.tile.id, dashboardId: first.dashboard.id, dashboardName: 'Ops' }])
    expect(JSON.stringify(withCore)).not.toMatch(/core-d1|web-1|Web board/)
    expect(listed).toMatchObject({ ok: true, components: [{ name: 'deals', agentId: 'remote:a', agentName: 'Ops Bot', cloud: { remoteAgentId: 'core-a', server: 'cinna.example.com' } }], placements: [{ tileId: first.tile.id }] })
    expect(await service.cloudComponents('p1', 'remote:b')).toMatchObject({ ok: false, code: 'not_owner' })
    client.listComponents.mockResolvedValueOnce(refusal('reauth_required'))
    expect(await service.cloudComponents('p1', 'remote:a')).toEqual({ ok: false, code: 'reauth_required', message: 'Sign in to cinna.example.com again.' })
    expect(await service.cloudComponents('p1', 'remote:nope')).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('parses an html cloud component without looking for its files', async () => {
    const page = { schema_version: 1, title: 'Board', view: 'html', entry: 'index.html', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } } }
    client.getComponent.mockResolvedValueOnce(ok(component({ name: 'board', view: 'html', component_json: page })))
    const added = await service.addCloudTile('p1', { newDashboardName: 'Ops', agentId: 'remote:a', component: 'board' })
    if (!added.ok) throw new Error(added.message)
    const resolved = service.resolveTile('p1', added.tile.id)
    expect(resolved?.view).toMatchObject({ state: 'ok', component: { view: 'html', valid: true, findings: [] } })
    expect(resolved?.cloud).toMatchObject({ coreDashboardId: 'core-d1', coreBlockId: 'blk-1', remoteAgentId: 'core-a', agentName: 'Ops Bot', spec: { view: 'html', entry: 'index.html' } })
    expect(service.resolveCloudBlock('p1', 'blk-1')?.tile.id).toBe(added.tile.id)
  })
})

describe('references to cloud components (D6.8)', () => {
  const resolve = async (reference: string, chatAgentId?: string) => {
    const out = await service.resolveReference('p1', { reference, chatAgentId })
    if (!out.ok) throw new Error(out.message)
    return out.resolution
  }

  it('resolves a bundle to the profile’s own cloud agent through core’s GET, with its placements', async () => {
    const first = await addOps()
    expect(await resolve('cinna://component/bundle:io.example.ops/deals')).toMatchObject({
      found: true, component: { agentId: 'remote:a', cloud: { remoteAgentId: 'core-a' } }, placements: [{ tileId: first.tile.id }], canonicalReference: 'cinna://component/bundle:io.example.ops/deals'
    })
    expect(client.getComponent).toHaveBeenLastCalledWith('p1', 'core-a', 'deals', null)
  })

  it('says not_owner, unreachable, not_in_this_copy and not installed', async () => {
    expect(await resolve('cinna://component/bundle:io.example.shared/deals')).toMatchObject({ found: false, reason: 'not_owner', agentName: 'Shared Bot', agentId: 'remote:b' })
    client.getComponent.mockResolvedValueOnce(refusal('unreachable'))
    expect(await resolve('cinna://component/bundle:io.example.ops/deals')).toMatchObject({ found: false, reason: 'unreachable', agentName: 'Ops Bot' })
    client.getComponent.mockResolvedValueOnce(refusal('not_found', 404))
    expect(await resolve('cinna://component/bundle:io.example.ops/deals')).toMatchObject({ found: false, reason: 'not_in_this_copy' })
    expect(await resolve('cinna://component/bundle:io.example.none/deals')).toMatchObject({ found: false, reason: 'bundle_not_installed' })
  })

  it('finds the newest core session of the profile’s chats with a remote agent', () => {
    const raw = holder.current!.raw
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec(`INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES ('c1', 'p1', 'a', 1, 1), ('c2', 'p1', 'b', 1, 1), ('c3', 'p2', 'c', 1, 1);
      INSERT INTO a2a_sessions (id, chat_id, agent_id, task_id, created_at, updated_at) VALUES
        ('s1', 'c1', 'remote:a', 'sess-old', 1, 10), ('s2', 'c2', 'remote:a', 'sess-new', 1, 20),
        ('s3', 'c3', 'remote:a', 'sess-other-profile', 1, 30), ('s4', 'c2', 'remote:b', NULL, 1, 40);`)
    expect(dashboardRepo.latestCoreSessionForAgent('p1', 'remote:a')).toBe('sess-new')
    expect(dashboardRepo.latestCoreSessionForAgent('p1', 'remote:b')).toBeNull()
    expect(dashboardRepo.latestCoreSessionForAgent('p2', 'remote:a')).toBe('sess-other-profile')
  })

  it('reaches a cloud agent by id or slug only from its own chat, and only when core matches it to that agent', async () => {
    const ref = 'cinna://component/id:0f8fad5b-d9cb-469f-a165-70867728950e/deals'
    const resolveRefs = vi.fn(async (_u: string, refs: string[]) => ok({ results: [{ ref: refs[0], status: 'ok', message: null, agent: { id: 'core-a', name: 'Ops Bot' }, component: null, from_skill: null, findings: [], placements: [], catalog_name: null }] }))
    const sessions: Record<string, string> = { 'remote:a': 'sess-a' }
    const otherAgents = [{ id: 'folder:x', manifestId: 'x', name: 'Local Ops', slug: 'ops-bot' }]
    const svc = createDashboardService({
      agents: () => [],
      otherAgents: () => otherAgents,
      cloud: {
        agents: () => cloudAgents, serverUrl: () => server, client: { ...client, resolveRefs } as never, backing,
        chatCoreSession: (_u, agentRowId) => sessions[agentRowId] ?? null, publish: () => {}, now: () => clock
      }
    })
    const resolveIn = async (reference: string, chatAgentId?: string) => {
      const out = await svc.resolveReference('p1', { reference, chatAgentId })
      if (!out.ok) throw new Error(out.message)
      return out.resolution
    }
    // Outside a cloud chat: not here, and core is not asked.
    expect(await resolveIn(ref)).toMatchObject({ found: false, reason: 'agent_not_here' })
    expect(resolveRefs).not.toHaveBeenCalled()
    // In its own chat, with core's match: found, asked with that chat's core session.
    expect(await resolveIn(ref, 'remote:a')).toMatchObject({ found: true, component: { agentId: 'remote:a' }, canonicalReference: 'cinna://component/bundle:io.example.ops/deals' })
    expect(resolveRefs).toHaveBeenLastCalledWith('p1', [ref], 'sess-a')
    // The chat's own cloud agent wins over a local agent with the same slug.
    expect(await resolveIn('cinna://component/ops-bot/deals', 'remote:a')).toMatchObject({ found: true, component: { agentId: 'remote:a' } })
    // Core says it names another agent: never the chat's cloud agent's component.
    resolveRefs.mockResolvedValueOnce(ok({ results: [{ ref, status: 'gone', message: 'x', agent: null, component: null, from_skill: null, findings: [], placements: [], catalog_name: null }] }) as never)
    expect(await resolveIn(ref, 'remote:a')).toMatchObject({ found: false, reason: 'agent_not_here' })
    // …and then the local namesake gets its turn.
    resolveRefs.mockResolvedValueOnce(ok({ results: [{ ref, status: 'gone', message: 'x', agent: null, component: null, from_skill: null, findings: [], placements: [], catalog_name: null }] }) as never)
    expect(await resolveIn('cinna://component/ops-bot/deals', 'remote:a')).toMatchObject({ found: false, reason: 'not_kit_agent', agentId: 'folder:x' })
    // Matched to it, but it has no such component.
    resolveRefs.mockResolvedValueOnce(ok({ results: [{ ref, status: 'gone', message: 'x', agent: { id: 'core-a', name: 'Ops Bot' }, component: null, from_skill: null, findings: [], placements: [], catalog_name: null }] }) as never)
    expect(await resolveIn(ref, 'remote:a')).toMatchObject({ found: false, reason: 'gone', agentId: 'remote:a' })
    // Core unreachable, nothing local: said so.
    resolveRefs.mockResolvedValueOnce(refusal('unreachable') as never)
    expect(await resolveIn(ref, 'remote:a')).toMatchObject({ found: false, reason: 'unreachable' })
    // A chat with no core session yet asks nothing.
    delete sessions['remote:a']
    resolveRefs.mockClear()
    expect(await resolveIn(ref, 'remote:a')).toMatchObject({ found: false, reason: 'agent_not_here' })
    expect(resolveRefs).not.toHaveBeenCalled()
    // An agent the profile does not own: its chat's references can't be added.
    expect(await resolveIn('cinna://component/shared-bot/deals', 'remote:b')).toMatchObject({ found: false, reason: 'not_owner' })
  })
})
