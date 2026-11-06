import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../../db/testSupport/nodeSqlite'

/**
 * Cloud tiles through the refresh service (D6.4, D6.5, D6.7, D6.10), over the
 * real repository with core's client, events and clock scripted: the mirror,
 * when a read wakes, the marks, the poll without a socket, params, calls,
 * previews and core's events.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../../../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
vi.mock('../../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent', nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }) }
}))
vi.mock('../../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: [] }), locate: () => { throw new Error('unused') } } }))
vi.mock('../../cinna-http', () => ({ cinnaSend: vi.fn(async () => { throw new Error('no network in tests') }), resolveBaseUrl: () => 'https://cinna.example.com' }))
vi.mock('../../../shell/env', () => ({ getShellEnv: async () => process.env, shellEnvForChild: (env: NodeJS.ProcessEnv) => env }))

const { createDashboardService } = await import('../dashboardService')
const { createDashboardRefreshService } = await import('../dashboardRefreshService')
const { createBackingDashboards } = await import('./backingDashboards')
const { dashboardRepo } = await import('../../../db/dashboards')
const { CLOUD_TILE_POLL_MS, DASHBOARD_LEASE_TTL_MS } = await import('../../../../shared/dashboards')
type CoreTileData = import('./coreDashboardsClient').CoreTileData

const SERVER = 'https://cinna.example.com'
const ok = <T,>(value: T) => ({ ok: true as const, value })
const refusal = (code: string, message = '') => ({ ok: false as const, code: code as never, message, status: null })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const data = (overrides: Partial<CoreTileData> = {}): CoreTileData => ({
  data: { items: [{ id: 'd1', title: 'Acme' }] }, stale: false, fetched_at: '2026-11-04T10:00:00Z', mark: null, mark_at: null, notice: null,
  params_resolved: { month: '2026-11' }, missing_credentials: [], skipped: null, ...overrides
})

const spec = (refresh: Record<string, unknown> = {}) => ({
  schema_version: 1, title: 'Deals', view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } },
  params: { month: { type: 'month', default: 'current' } }, refresh
})

let clock: number
let live: boolean
let client: Record<string, Mock<(...args: any[]) => any>>
let events: { want: Mock<(...args: any[]) => any>; isLive: () => boolean }
let highlight: Mock<(...args: any[]) => any>
let published: string[]
let intervals: Array<{ fn: () => void; ms: number; cleared: boolean }>
let dashboards: ReturnType<typeof createDashboardService>
let refresh: ReturnType<typeof createDashboardRefreshService>
let tileId: string

async function addTile(componentJson: Record<string, unknown> = spec(), extra: Record<string, unknown> = {}): Promise<string> {
  client.getComponent.mockResolvedValueOnce(ok({ name: 'deals', skill: null, title: 'Deals', view: 'list', component_json: componentJson, findings: [], has_errors: false, size_bytes: 1, placements: [] }))
  const added = await dashboards.addCloudTile('p1', { newDashboardName: `Ops ${Math.random()}`, agentId: 'remote:a', component: 'deals', ...extra })
  if (!added.ok) throw new Error(added.message)
  return added.tile.id
}

beforeEach(async () => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('p1', 'cinna_user', 'p1', 'P1', 1);`)
  clock = Date.parse('2026-11-04T10:00:30Z')
  live = false
  published = []
  intervals = []
  client = {
    getComponent: vi.fn(),
    listComponents: vi.fn(async () => ok({ components: [] })),
    addBlock: vi.fn(async () => ok({ id: 'blk-1', agent_id: 'core-a', view_type: 'agent_component', title: null, config: null })),
    deleteBlock: vi.fn(async () => ok({})),
    createDashboard: vi.fn(async (_u: string, name: string) => ok({ id: 'core-d1', name, blocks: [] })),
    getDashboard: vi.fn(async () => ok({ id: 'core-d1', name: 'Ops', blocks: [] })),
    renameDashboard: vi.fn(async () => ok({})),
    deleteDashboard: vi.fn(async () => ok({})),
    updateBlock: vi.fn(async () => ok({})),
    tileData: vi.fn(async () => ok(data())),
    refreshTile: vi.fn(async () => ok(data())),
    setTileParams: vi.fn(async () => ok(data())),
    callTile: vi.fn(async () => ok({ value: { rows: [1] } })),
    runComponent: vi.fn(async () => ok({ value: { items: [] }, fetched_at: '2026-11-04T10:00:00Z', notice: null, params_resolved: { month: '2026-11' } }))
  }
  events = { want: vi.fn(), isLive: () => live }
  highlight = vi.fn()
  const backing = createBackingDashboards({ client: client as never, serverUrl: () => SERVER })
  dashboards = createDashboardService({
    agents: () => [],
    cloud: {
      agents: () => [{ id: 'remote:a', name: 'Ops Bot', remoteTargetId: 'core-a', owned: true, bundleId: null }],
      serverUrl: () => SERVER,
      client: client as never,
      backing,
      publish: (id) => published.push(id),
      now: () => clock
    }
  })
  refresh = createDashboardRefreshService({
    dashboards,
    runner: { run: vi.fn(async () => { throw new Error('a cloud tile never runs an endpoint here') }) },
    runCommand: vi.fn(),
    publish: (id) => published.push(id),
    now: () => clock,
    timers: {
      setInterval: (fn, ms) => {
        const handle = { fn, ms, cleared: false }
        intervals.push(handle)
        return handle
      },
      clearInterval: (handle) => {
        ;(handle as { cleared: boolean }).cleared = true
      }
    },
    cloud: { client: client as never, events, highlight }
  })
  tileId = await addTile()
})
afterEach(() => {
  refresh.cancelAll()
  holder.current?.close()
})

const result = () => {
  const out = refresh.tileResult('p1', tileId)
  if (!out.ok) throw new Error(out.message)
  return out.result
}

describe('on screen', () => {
  it('reads core’s data when the tile comes on screen, mirrors it, and does not wake a fresh tile', async () => {
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    expect(client.tileData).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1')
    expect(client.refreshTile).not.toHaveBeenCalled()
    expect(events.want).toHaveBeenCalledWith('p1', true)
    expect(result()).toMatchObject({
      data: { items: [{ id: 'd1' }] }, fetchedAt: Date.parse('2026-11-04T10:00:00Z'), stale: false, error: null, refreshing: false,
      cloud: { mark: null, paramsResolved: { month: '2026-11' }, missingCredentials: [] }
    })
    expect(dashboardRepo.result(tileId, 'cloud')?.resultJson).toBe(JSON.stringify({ items: [{ id: 'd1', title: 'Acme' }] }))
    // A renewal while on screen reads nothing more (the poll and core's events do).
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    expect(client.tileData).toHaveBeenCalledTimes(1)
  })

  it('asks core to recompute a stale tile: `open` the first time in this run, `reshow` after, Waking meanwhile', async () => {
    client.tileData.mockResolvedValue(ok(data({ stale: true })))
    let finish: (value: unknown) => void = () => {}
    client.refreshTile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    refresh.renewLease('p1', [tileId])
    await tick()
    await tick()
    expect(client.refreshTile).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', 'open')
    expect(result()).toMatchObject({ refreshing: true, data: { items: [{ id: 'd1' }] }, cloud: { mark: { code: 'waking', message: 'Waking Ops Bot…' } } })
    finish(ok(data({ data: { items: [] }, stale: false })))
    await refresh.remote.settled()
    expect(result()).toMatchObject({ refreshing: false, data: { items: [] }, cloud: { mark: null } })

    refresh.dropLease('p1', [tileId])
    expect(events.want).toHaveBeenLastCalledWith('p1', false)
    clock += 5_000
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    expect(client.refreshTile).toHaveBeenLastCalledWith('p1', 'core-d1', 'blk-1', 'reshow')
  })

  it('wakes a stale tile that came on screen while a read that may not wake ran (core’s event, the poll)', async () => {
    client.tileData.mockResolvedValue(ok(data({ stale: true })))
    let answer: (value: unknown) => void = () => {}
    client.tileData.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    client.getDashboard.mockResolvedValue(ok({ id: 'core-d1', name: 'Ops', blocks: [] }))
    // Core's event starts a read that never wakes…
    const updated = refresh.cloudTileUpdated('p1', 'blk-1')
    await tick()
    // …and the tile comes on screen meanwhile.
    refresh.renewLease('p1', [tileId])
    await tick()
    expect(client.refreshTile).not.toHaveBeenCalled()
    answer(ok(data({ stale: true })))
    await updated
    await refresh.remote.settled()
    expect(client.refreshTile).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', 'open')
    expect(client.tileData).toHaveBeenCalledTimes(1)
  })

  it('wakes a stale tile that comes on screen just after a read that may not wake answered', async () => {
    client.tileData.mockResolvedValue(ok(data({ stale: true })))
    await refresh.cloudTileUpdated('p1', 'blk-1')
    await refresh.remote.settled()
    expect(client.refreshTile).not.toHaveBeenCalled()
    clock += 500
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    // Within the dedupe window: no second read, but the wake the first one could not ask for.
    expect(client.tileData).toHaveBeenCalledTimes(1)
    expect(client.refreshTile).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', 'open')
    // A renewal after that asks nothing more.
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    expect(client.refreshTile).toHaveBeenCalledTimes(1)
  })

  it('leaves a Manual tile with data alone when it is stale, and Refresh asks `manual`', async () => {
    dashboards.updateTile('p1', { tileId, refreshOverride: { manual: true } })
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    client.tileData.mockResolvedValue(ok(data({ stale: true })))
    refresh.dropLease('p1')
    clock += 5_000
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    expect(client.refreshTile).not.toHaveBeenCalled()
    await refresh.ensureFresh('p1', tileId, 'manual', { wait: true })
    expect(client.refreshTile).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', 'manual')
  })

  it('keeps the data and marks why when core cannot be reached, wants a sign-in, has lost the agent or the environment is down', async () => {
    await refresh.ensureFresh('p1', tileId, 'visible', { wait: true })
    const cases: Array<[string, string, string]> = [
      ['unreachable', 'unreachable', 'Can’t reach cinna.example.com.'],
      ['reauth_required', 'reauth_required', 'Sign in to cinna.example.com again.'],
      ['not_found', 'agent_gone', 'Ops Bot is no longer available.'],
      ['env_unavailable', 'env_unavailable', 'Ops Bot’s environment isn’t running.'],
      ['rate_limited', 'rate_limited', 'This tile ran its endpoints more than 30 times in a minute; wait a moment and try again.']
    ]
    for (const [code, mark, message] of cases) {
      client.refreshTile.mockResolvedValueOnce(refusal(code))
      await refresh.ensureFresh('p1', tileId, 'manual', { wait: true })
      expect(result()).toMatchObject({ data: { items: [{ id: 'd1' }] }, error: message, cloud: { mark: { code: mark, message } } })
    }
    client.refreshTile.mockResolvedValueOnce(refusal('adapter_unsupported', 'Rebuild the environment to show components.'))
    await refresh.ensureFresh('p1', tileId, 'manual', { wait: true })
    expect(result().cloud?.mark).toEqual({ code: 'adapter_unsupported', message: 'Rebuild the environment to show components.' })
    client.refreshTile.mockResolvedValueOnce(ok(data({ missing_credentials: ['CRM_TOKEN'] })))
    await refresh.ensureFresh('p1', tileId, 'manual', { wait: true })
    expect(result().cloud).toMatchObject({ mark: { code: 'needs_credentials', message: 'Needs the “CRM_TOKEN” credential.' }, missingCredentials: ['CRM_TOKEN'] })
  })
})

describe('timed and turn refreshes', () => {
  it('asks `interval` on the tile’s own timer while on screen, and an asleep skip is no error', async () => {
    tileId = await addTile(spec({ while_open_every: '2m' }))
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    const timer = intervals.find((entry) => entry.ms === 120_000)!
    expect(timer).toBeTruthy()
    client.refreshTile.mockResolvedValueOnce(ok(data({ skipped: 'env_asleep', stale: true })))
    timer.fn()
    await refresh.remote.settled()
    expect(client.refreshTile).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', 'interval')
    expect(result()).toMatchObject({ error: null, cloud: { mark: null }, data: { items: [{ id: 'd1' }] } })
  })

  it('asks `after_turn` for the agent’s on-screen cloud tiles whose rule asks for it, and never warms one up at launch', async () => {
    tileId = await addTile(spec({ after_turn: true }))
    const offscreen = await addTile(spec({ after_turn: true }))
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    expect(refresh.afterTurn('p1', 'remote:a')).toEqual([tileId])
    await refresh.remote.settled()
    expect(client.refreshTile).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', 'after_turn')
    expect(client.refreshTile).toHaveBeenCalledTimes(1)
    expect(offscreen).not.toBe(tileId)
    dashboards.updateTile('p1', { tileId, refreshOverride: { onAppStart: true } })
    expect(await refresh.warmUp('p1')).toEqual([])
  })

  it('asks nothing after a turn of a tile whose component does not ask for it, and follows the tile’s override', async () => {
    // The beforeEach tile: an endpoint source, no `refresh.after_turn`. Core recomputes on every after_turn it gets.
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    refresh.afterTurn('p1', 'remote:a')
    await refresh.remote.settled()
    expect(client.refreshTile).not.toHaveBeenCalled()
    dashboards.updateTile('p1', { tileId, refreshOverride: { afterTurn: true } })
    refresh.afterTurn('p1', 'remote:a')
    await refresh.remote.settled()
    expect(client.refreshTile).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', 'after_turn')
    // And the component's own `after_turn: true` turned off by the override.
    client.refreshTile.mockClear()
    const asks = await addTile(spec({ after_turn: true }), { refreshOverride: { afterTurn: false } })
    refresh.renewLease('p1', [asks])
    await refresh.remote.settled()
    refresh.afterTurn('p1', 'remote:a')
    await refresh.remote.settled()
    expect(client.refreshTile).toHaveBeenCalledTimes(1)
  })
})

describe('without core’s events', () => {
  it('re-reads on-screen cloud tiles every poll while the socket is down, not while it is live, and stops when the lease lapses', async () => {
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    const poll = intervals.find((entry) => entry.ms === CLOUD_TILE_POLL_MS)!
    expect(refresh.remote.isPolling('p1')).toBe(true)
    poll.fn()
    await refresh.remote.settled()
    expect(client.tileData).toHaveBeenCalledTimes(2)
    // A poll never wakes: a stale answer asks nothing of core.
    client.tileData.mockResolvedValueOnce(ok(data({ stale: true })))
    poll.fn()
    await refresh.remote.settled()
    expect(client.refreshTile).not.toHaveBeenCalled()
    live = true
    poll.fn()
    await refresh.remote.settled()
    expect(client.tileData).toHaveBeenCalledTimes(3)

    clock += DASHBOARD_LEASE_TTL_MS + 1
    poll.fn()
    expect(events.want).toHaveBeenLastCalledWith('p1', false)
    expect(poll.cleared).toBe(true)
    expect(refresh.remote.isPolling('p1')).toBe(false)
  })
})

describe('after an outage', () => {
  it('clears an unreachable mark on the next poll that core answers', async () => {
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    client.tileData.mockResolvedValueOnce(refusal('unreachable'))
    const poll = intervals.find((entry) => entry.ms === CLOUD_TILE_POLL_MS)!
    poll.fn()
    await refresh.remote.settled()
    expect(result().cloud?.mark?.code).toBe('unreachable')
    poll.fn()
    await refresh.remote.settled()
    expect(result().cloud?.mark).toBeNull()
    expect(result().error).toBeNull()
  })

  it('re-reads every on-screen cloud tile, never waking, when core’s socket connects again', async () => {
    refresh.renewLease('p1', [tileId])
    await refresh.remote.settled()
    client.tileData.mockResolvedValueOnce(refusal('unreachable'))
    intervals.find((entry) => entry.ms === CLOUD_TILE_POLL_MS)!.fn()
    await refresh.remote.settled()
    expect(result().cloud?.mark?.code).toBe('unreachable')
    const reads = client.tileData.mock.calls.length
    client.tileData.mockResolvedValueOnce(ok(data({ stale: true })))
    refresh.cloudConnected('p1')
    await refresh.remote.settled()
    expect(client.tileData).toHaveBeenCalledTimes(reads + 1)
    expect(client.refreshTile).not.toHaveBeenCalled()
    expect(result().cloud?.mark).toBeNull()
    // Another profile's connection reads nothing of this one's.
    refresh.cloudConnected('p2')
    await refresh.remote.settled()
    expect(client.tileData).toHaveBeenCalledTimes(reads + 1)
  })
})

describe('params, calls and previews', () => {
  it('sends the whole param set to core and mirrors the owner’s values and core’s resolved ones', async () => {
    client.setTileParams.mockResolvedValueOnce(ok(data({ params_resolved: { month: '2026-01' } })))
    expect(await refresh.setParams('p1', { tileId, params: { month: '2026-01' } })).toMatchObject({ ok: true, tile: { params: { month: '2026-01' }, cloud: { remoteAgentId: 'core-a' } } })
    expect(client.setTileParams).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', { month: '2026-01' })
    expect(result().cloud?.paramsResolved).toEqual({ month: '2026-01' })
    expect(await refresh.setParams('p1', { tileId, params: { month: 'January' } })).toMatchObject({ ok: false, code: 'invalid_input' })
    client.setTileParams.mockResolvedValueOnce(refusal('rate_limited', 'Too many runs for this tile; try again shortly.'))
    expect(await refresh.setParams('p1', { tileId, params: { month: '2026-02' } })).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(dashboardRepo.tile('p1', tileId)?.paramsJson).toBe(JSON.stringify({ month: '2026-01' }))
  })

  it('runs a page’s call through core, and a cloud-only refusal reaches the page as call_failed', async () => {
    expect(await refresh.call('p1', { target: { tileId }, endpoint: 'history', params: { deal_id: 'd1' } })).toEqual({ ok: true, value: { rows: [1] } })
    expect(client.callTile).toHaveBeenCalledWith('p1', 'core-d1', 'blk-1', 'history', { deal_id: 'd1' })
    client.callTile.mockResolvedValueOnce(refusal('env_unavailable'))
    expect(await refresh.call('p1', { target: { tileId }, endpoint: 'history' })).toEqual({ ok: false, code: 'call_failed', message: 'Ops Bot’s environment isn’t running.' })
    client.callTile.mockResolvedValueOnce(refusal('adapter_unsupported', 'Rebuild it.'))
    expect(await refresh.call('p1', { target: { tileId }, endpoint: 'history' })).toMatchObject({ ok: false, code: 'call_failed' })
    client.callTile.mockResolvedValueOnce(refusal('rate_limited', 'slow down'))
    expect(await refresh.call('p1', { target: { tileId }, endpoint: 'history' })).toMatchObject({ ok: false, code: 'rate_limited' })
  })

  it('previews a cloud component as a `preview` run', async () => {
    expect(await refresh.preview('p1', 'remote:a', 'deals', null, { month: '2026-03' })).toMatchObject({ ok: true, result: { data: { items: [] }, cloud: { paramsResolved: { month: '2026-11' } } } })
    expect(client.runComponent).toHaveBeenCalledWith('p1', 'core-a', 'deals', { skill: null, params: { month: '2026-03' }, tileKey: 'preview' })
    client.runComponent.mockResolvedValueOnce(refusal('unreachable'))
    expect(await refresh.preview('p1', 'remote:a', 'deals')).toMatchObject({ ok: true, result: { data: null, error: 'Can’t reach cinna.example.com.', cloud: { mark: { code: 'unreachable' } } } })
  })
})

describe('core’s events (D6.7)', () => {
  it('re-reads a tile and its block’s params when core says it changed, and passes a highlight on by tile id', async () => {
    client.tileData.mockResolvedValueOnce(ok(data({ data: { items: [{ id: 'd9' }] } })))
    client.getDashboard.mockResolvedValueOnce(ok({
      id: 'core-d1', name: 'Ops', blocks: [{ id: 'blk-1', agent_id: 'core-a', view_type: 'agent_component', title: null, config: { component: 'deals', params: { month: '2026-05' } } }]
    }))
    published.length = 0
    await refresh.cloudTileUpdated('p1', 'blk-1')
    expect(result().data).toEqual({ items: [{ id: 'd9' }] })
    expect(dashboardRepo.tile('p1', tileId)?.paramsJson).toBe(JSON.stringify({ month: '2026-05' }))
    expect(published).toContain(tileId)
    await refresh.cloudTileUpdated('p1', 'blk-unknown')
    expect(client.tileData).toHaveBeenCalledTimes(1)

    refresh.cloudTileHighlight('p1', 'blk-1', ['d9'])
    expect(highlight).toHaveBeenCalledWith(tileId, ['d9'])
    refresh.cloudTileHighlight('p2', 'blk-1', ['d9'])
    expect(highlight).toHaveBeenCalledTimes(1)
  })
})
