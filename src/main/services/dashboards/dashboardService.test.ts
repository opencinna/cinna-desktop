import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * Dashboards and tiles over the real migration chain and the real Drizzle
 * repository (`node:sqlite` adapter), with kit agents in real temp folders.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent' }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: [] }) } }))

const { agentBundleId, createDashboardService, credentialSlotReady } = await import('./dashboardService')
const { migrateDashboards } = await import('../../db/migrations/dashboards')
type ComponentAgent = import('./componentScanner').ComponentAgent
type OtherAgent = import('./dashboardService').OtherAgent
const { dashboardRepo, KEPT_PARAM_SETS } = await import('../../db/dashboards')
const { MAX_DASHBOARDS_PER_PROFILE, MAX_TILES_PER_DASHBOARD } = await import('../../../shared/dashboards')

let base = ''
const agents: ComponentAgent[] = []
const others: OtherAgent[] = []

function kitAgent(manifestId: string, components: Record<string, object>): void {
  const path = join(base, manifestId || 'legacy')
  for (const [name, spec] of Object.entries(components)) {
    const file = join(path, 'dashboards', name, 'component.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(spec))
    mkdirSync(join(path, 'dashboards', name, 'api'), { recursive: true })
    writeFileSync(join(path, 'dashboards', name, 'api', 'data.py'), 'print("{}")')
  }
  agents.push({ id: `folder:${manifestId || 'legacy-pos'}`, manifestId, name: `Agent ${manifestId}`, path, slug: `agent-${manifestId || 'legacy'}` })
}

const list = { schema_version: 1, title: 'Open deals', view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, size: 'l', params: { month: { type: 'month', default: 'current' } } }
const broken = { schema_version: 1, view: 'list' }

let service: ReturnType<typeof createDashboardService>

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('p1', 'cinna_user', 'p1', 'P1', 1), ('p2', 'cinna_user', 'p2', 'P2', 1);`)
  base = mkdtempSync(join(tmpdir(), 'dash-svc-'))
  agents.length = 0
  others.length = 0
  kitAgent('m1', { deals: list, broken })
  kitAgent('', { deals: list })
  service = createDashboardService({ agents: () => agents, otherAgents: () => others })
})
afterEach(() => {
  holder.current?.close()
  rmSync(base, { recursive: true, force: true })
})

function addDeals(dashboardId: string) {
  return service.addTile('p1', { dashboardId, agentId: 'folder:m1', component: 'deals' })
}

describe('dashboards', () => {
  it('are per profile, ordered, renamed and deleted with their tiles and results', () => {
    const a = service.create('p1', '  Sales   overview ')
    const b = service.create('p1', 'Ops')
    expect(a).toMatchObject({ ok: true, dashboard: { name: 'Sales overview', tileCount: 0 } })
    if (!a.ok || !b.ok) throw new Error('create failed')
    expect(service.list('p2')).toEqual([])
    expect(service.list('p1').map((d) => d.name)).toEqual(['Sales overview', 'Ops'])
    service.reorder('p1', [b.dashboard.id])
    expect(service.list('p1').map((d) => d.name)).toEqual(['Ops', 'Sales overview'])
    expect(service.rename('p2', a.dashboard.id, 'Mine')).toMatchObject({ ok: false, code: 'not_found' })
    expect(service.rename('p1', a.dashboard.id, 'Pipeline')).toMatchObject({ ok: true, dashboard: { name: 'Pipeline' } })

    const tile = addDeals(a.dashboard.id)
    if (!tile.ok) throw new Error(tile.message)
    dashboardRepo.saveResult(tile.tile.id, 'h', { resultJson: '{"items":[]}', fetchedAt: 1, error: null, durationMs: 5 })
    expect(service.list('p1').find((d) => d.id === a.dashboard.id)?.tileCount).toBe(1)
    expect(service.delete('p2', a.dashboard.id)).toMatchObject({ ok: false, code: 'not_found' })
    expect(service.delete('p1', a.dashboard.id)).toEqual({ ok: true })
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM dashboard_tiles').get()).toEqual({ n: 0 })
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM dashboard_tile_results').get()).toEqual({ n: 0 })
  })

  it('refuses a blank name and a twenty-first dashboard as data', () => {
    expect(service.create('p1', '   ')).toMatchObject({ ok: false, code: 'invalid_input' })
    for (let i = 0; i < MAX_DASHBOARDS_PER_PROFILE; i++) expect(service.create('p1', `D${i}`).ok).toBe(true)
    expect(service.create('p1', 'One more')).toMatchObject({ ok: false, code: 'limit_reached' })
    expect(service.create('p2', 'Other profile').ok).toBe(true)
  })
})

describe('tiles', () => {
  it('reference the agent by manifest id and the component by name, with its defaults', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const added = addDeals(d.dashboard.id)
    expect(added).toMatchObject({ ok: true, tile: { agentManifestId: 'm1', component: 'deals', title: null, size: 'l', params: { month: 'current' }, position: 0 } })
    const tiles = service.tiles('p1', d.dashboard.id)
    expect(tiles).toMatchObject({ ok: true, tiles: [{ displayTitle: 'Open deals', state: 'ok', component: { valid: true } }] })
    expect(service.tiles('p2', d.dashboard.id)).toMatchObject({ ok: false, code: 'not_found' })
    expect(service.placements('p1', 'folder:m1')).toEqual([expect.objectContaining({ component: 'deals', dashboardName: 'Sales' })])
    expect(service.placements('p2', 'folder:m1')).toEqual([])
  })

  it('can create the dashboard they go on', () => {
    expect(service.addTile('p1', { newDashboardName: 'New one', agentId: 'folder:m1', component: 'deals', size: 's', title: 'Mine' })).toMatchObject({
      ok: true, dashboard: { name: 'New one', tileCount: 1 }, tile: { size: 's', title: 'Mine' }
    })
  })

  it('refuse an invalid component, a legacy agent with no id, and a missing component, as data', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    expect(service.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m1', component: 'broken' })).toMatchObject({ ok: false, code: 'component_invalid' })
    expect(service.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:legacy-pos', component: 'deals' })).toMatchObject({ ok: false, code: 'needs_identity', message: 'This agent needs an id first.' })
    expect(service.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m1', component: 'gone' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(service.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m1', component: 'deals', size: 'xl' })).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('refuse a twenty-fifth tile on one dashboard as data', () => {
    const d = service.create('p1', 'Full')
    if (!d.ok) throw new Error()
    for (let i = 0; i < MAX_TILES_PER_DASHBOARD; i++) expect(addDeals(d.dashboard.id).ok).toBe(true)
    expect(addDeals(d.dashboard.id)).toMatchObject({ ok: false, code: 'limit_reached' })
  })

  it('move, resize, retitle and leave', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const ids = [0, 1, 2].map(() => { const t = addDeals(d.dashboard.id); if (!t.ok) throw new Error(); return t.tile.id })
    expect(service.moveTile('p1', ids[2], 0)).toEqual({ ok: true })
    const order = () => { const t = service.tiles('p1', d.dashboard.id); return t.ok ? t.tiles.map((v) => v.tile.id) : [] }
    expect(order()).toEqual([ids[2], ids[0], ids[1]])
    expect(service.moveTile('p2', ids[0], 2)).toMatchObject({ ok: false, code: 'not_found' })
    expect(service.updateTile('p1', { tileId: ids[0], size: 'wide', title: 'Deals', refreshOverride: { maxAge: '1h', manual: true } })).toMatchObject({
      ok: true, tile: { size: 'wide', title: 'Deals', refreshOverride: { maxAge: '1h', manual: true } }
    })
    expect(service.updateTile('p1', { tileId: ids[0], refreshOverride: { maxAge: 'soon' } })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(service.removeTile('p2', ids[0])).toMatchObject({ ok: false })
    expect(service.removeTile('p1', ids[0])).toEqual({ ok: true })
    expect(order()).toEqual([ids[2], ids[1]])
  })

  it('take a custom size with its cells, keep them under a preset, and refuse cells off the grid', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const t = addDeals(d.dashboard.id)
    if (!t.ok) throw new Error()
    const update = (patch: object) => service.updateTile('p1', { tileId: t.tile.id, ...patch })
    // Custom with no cells yet has nothing to draw.
    expect(update({ size: 'custom' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(update({ size: 'custom', customSpan: { cols: 5, rows: 3 } })).toMatchObject({ ok: true, tile: { size: 'custom', customSpan: { cols: 5, rows: 3 } } })
    expect(service.resolveTile('p1', t.tile.id)?.tile).toMatchObject({ size: 'custom', customSpan: { cols: 5, rows: 3 } })
    expect(update({ size: 'wide' })).toMatchObject({ ok: true, tile: { size: 'wide', customSpan: { cols: 5, rows: 3 } } })
    expect(update({ size: 'custom' })).toMatchObject({ ok: true, tile: { size: 'custom', customSpan: { cols: 5, rows: 3 } } })
    for (const customSpan of [{ cols: 1, rows: 2 }, { cols: 13, rows: 2 }, { cols: 4, rows: 0 }, { cols: 4, rows: 13 }, { cols: 2.5, rows: 2 }, { cols: '4', rows: 2 }]) {
      expect(update({ size: 'custom', customSpan })).toMatchObject({ ok: false, code: 'invalid_input' })
    }
    expect(update({ size: 'huge' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(service.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m1', component: 'deals', size: 'custom' })).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('take a change to the suggested questions from Edit tile, trimmed, and refuse an empty or oversized one', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const t = addDeals(d.dashboard.id)
    if (!t.ok) throw new Error()
    const update = (promptOverride: object | null) => service.updateTile('p1', { tileId: t.tile.id, promptOverride: promptOverride as never })
    expect(update({ hidden: ['A'], edited: { B: { label: ' B2 ', prompt: ' Text ' } }, added: [{ label: 'C', prompt: 'See', hidden: true }] })).toMatchObject({
      ok: true, tile: { promptOverride: { hidden: ['A'], edited: { B: { label: 'B2', prompt: 'Text' } }, added: [{ label: 'C', prompt: 'See', hidden: true }] } }
    })
    expect(service.resolveTile('p1', t.tile.id)?.tile.promptOverride?.hidden).toEqual(['A'])
    expect(update({ hidden: [], edited: {}, added: [] })).toMatchObject({ ok: true, tile: { promptOverride: null } })
    for (const bad of [{ added: [{ label: '', prompt: 'x' }] }, { added: [{ label: 'x', prompt: '   ' }] }, { edited: { A: { label: 'x'.repeat(61), prompt: 'y' } } }, { added: [{ label: 'x', prompt: 'y'.repeat(1001) }] }, { hidden: [1] }, { hidden: 'A' }]) {
      expect(update(bad)).toMatchObject({ ok: false, code: 'invalid_input' })
    }
    expect(update(null)).toMatchObject({ ok: true, tile: { promptOverride: null } })
  })

  it('take the full refresh override from Edit tile, the interval at least 1m (D4)', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const t = addDeals(d.dashboard.id)
    if (!t.ok) throw new Error()
    const update = (refreshOverride: object) => service.updateTile('p1', { tileId: t.tile.id, refreshOverride })
    expect(update({ whileOpenEvery: '5m', afterTurn: false, onAppStart: true })).toMatchObject({
      ok: true, tile: { refreshOverride: { whileOpenEvery: '5m', afterTurn: false, onAppStart: true } }
    })
    // Null turns a component's interval off, and is kept as such.
    expect(update({ whileOpenEvery: null })).toMatchObject({ ok: true, tile: { refreshOverride: { whileOpenEvery: null } } })
    expect(service.resolveTile('p1', t.tile.id)?.tile.refreshOverride).toEqual({ whileOpenEvery: null })
    for (const bad of [{ whileOpenEvery: '59s' }, { whileOpenEvery: 'often' }, { afterTurn: 'yes' }, { onAppStart: 1 }]) {
      expect(update(bad)).toMatchObject({ ok: false, code: 'invalid_input' })
    }
  })

  it('keep params set from a filter or the page, checked against the component’s params (D4)', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const t = addDeals(d.dashboard.id)
    if (!t.ok) throw new Error()
    expect(service.setParams('p1', { tileId: t.tile.id, params: { month: '2026-09', nope: 1 } })).toMatchObject({ ok: true, tile: { params: { month: '2026-09' } } })
    expect(service.resolveTile('p1', t.tile.id)?.tile.params).toEqual({ month: '2026-09' })
    expect(service.setParams('p1', { tileId: t.tile.id, params: { month: 'September' } })).toMatchObject({ ok: false, code: 'invalid_input', message: 'month must be a month (YYYY-MM) or current.' })
    expect(service.resolveTile('p1', t.tile.id)?.tile.params).toEqual({ month: '2026-09' })
    expect(service.setParams('p2', { tileId: t.tile.id, params: { month: '2026-10' } })).toMatchObject({ ok: false, code: 'not_found' })
    // The set replaces the old one: a key left out (a cleared field) goes, and its default applies again.
    expect(service.setParams('p1', { tileId: t.tile.id, params: {} })).toMatchObject({ ok: true, tile: { params: {} } })
  })

  it('say which schedule feeds them, whether it runs on this device, and when next (D4)', () => {
    const fed = { ...list, refresh: { schedule: 'nightly' } }
    kitAgent('m2', { inbox: fed, plain: list })
    writeFileSync(join(base, 'm2', 'cinna-agent.json'), JSON.stringify({ id: 'm2', schedules: [{ name: 'nightly' }] }))
    const onDevice = new Map<string, { onThisDevice: boolean; nextRunAt: number | null }>()
    const svc = createDashboardService({ agents: () => agents, scheduleOnDevice: (userId, manifestId, name) => onDevice.get(`${userId}|${manifestId}|${name}`) ?? { onThisDevice: false, nextRunAt: null } })
    const d = svc.create('p1', 'Inbox')
    if (!d.ok) throw new Error()
    const inbox = svc.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m2', component: 'inbox' })
    const plain = svc.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m2', component: 'plain' })
    if (!inbox.ok || !plain.ok) throw new Error()
    expect(svc.resolveTile('p1', inbox.tile.id)?.view.schedule).toEqual({ name: 'nightly', exists: true, onThisDevice: false, nextRunAt: null })
    expect(svc.resolveTile('p1', plain.tile.id)?.view.schedule).toBeNull()
    onDevice.set('p1|m2|nightly', { onThisDevice: true, nextRunAt: 42 })
    const views = svc.tiles('p1', d.dashboard.id)
    expect(views.ok && views.tiles.find((v) => v.tile.id === inbox.tile.id)?.schedule).toEqual({ name: 'nightly', exists: true, onThisDevice: true, nextRunAt: 42 })
    // Gone from the manifest: said as such, never as running here.
    writeFileSync(join(base, 'm2', 'cinna-agent.json'), JSON.stringify({ id: 'm2', schedules: [] }))
    expect(svc.resolveTile('p1', inbox.tile.id)?.view.schedule).toEqual({ name: 'nightly', exists: false, onThisDevice: false, nextRunAt: null })
    // The default reads the local scheduler's opt-in: no binding here is off.
    const real = createDashboardService({ agents: () => agents })
    writeFileSync(join(base, 'm2', 'cinna-agent.json'), JSON.stringify({ id: 'm2', schedules: [{ name: 'nightly' }] }))
    expect(real.resolveTile('p1', inbox.tile.id)?.view.schedule).toEqual({ name: 'nightly', exists: true, onThisDevice: false, nextRunAt: null })
  })

  it('say in place when the agent or component is gone, or the spec broke', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const t = addDeals(d.dashboard.id)
    if (!t.ok) throw new Error()
    writeFileSync(join(base, 'm1', 'dashboards', 'deals', 'component.json'), JSON.stringify({ ...list, view: 'pie' }))
    expect(service.resolveTile('p1', t.tile.id)?.view).toMatchObject({ state: 'invalid', component: { valid: false } })
    rmSync(join(base, 'm1', 'dashboards', 'deals'), { recursive: true })
    expect(service.resolveTile('p1', t.tile.id)?.view).toMatchObject({ state: 'component_missing', displayTitle: 'deals' })
    agents.splice(0, 1)
    expect(service.resolveTile('p1', t.tile.id)?.view).toMatchObject({ state: 'agent_missing' })
  })
})

describe('tile results', () => {
  it('keep the last good result beside a later error, and only the last three param sets', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const t = addDeals(d.dashboard.id)
    if (!t.ok) throw new Error()
    const id = t.tile.id
    dashboardRepo.saveResult(id, 'a', { resultJson: '{"v":1}', fetchedAt: 10, error: null, durationMs: 3 }, 10)
    dashboardRepo.saveResult(id, 'a', { error: 'exit 1', durationMs: 4 }, 11)
    expect(dashboardRepo.result(id, 'a')).toMatchObject({ resultJson: '{"v":1}', fetchedAt: 10, error: 'exit 1', updatedAt: 11 })
    dashboardRepo.saveResult(id, 'a', { resultJson: '{"v":2}', fetchedAt: 12, error: null, durationMs: 3 }, 12)
    expect(dashboardRepo.result(id, 'a')).toMatchObject({ resultJson: '{"v":2}', error: null })
    for (const [i, hash] of ['b', 'c', 'd'].entries()) dashboardRepo.saveResult(id, hash, { resultJson: '{}', fetchedAt: 20 + i, error: null, durationMs: 1 }, 20 + i)
    const kept = holder.current!.raw.prepare('SELECT params_hash FROM dashboard_tile_results WHERE tile_id = ? ORDER BY params_hash').all(id)
    expect(kept).toHaveLength(KEPT_PARAM_SETS)
    expect(kept).toEqual([{ params_hash: 'b' }, { params_hash: 'c' }, { params_hash: 'd' }])
  })
})

/** A skill folder holding `dashboards/<name>/`, outside every agent (a cache copy). */
function cachedSkill(skill: string, components: Record<string, object>): string {
  const dir = join(base, 'cache', skill)
  for (const [name, spec] of Object.entries(components)) {
    mkdirSync(join(dir, 'dashboards', name, 'api'), { recursive: true })
    writeFileSync(join(dir, 'dashboards', name, 'component.json'), JSON.stringify(spec))
    writeFileSync(join(dir, 'dashboards', name, 'api', 'data.py'), 'print("{}")')
  }
  return dir
}

describe('skill-shipped components (D15)', () => {
  it('are tiles keyed by (agent, skill, component); a removed skill leaves the tile saying its component is gone', () => {
    const dir = cachedSkill('crm', { deals: { ...list, title: 'CRM deals' } })
    let skills = [{ name: 'crm', dir }]
    agents[0].skills = () => skills
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const own = addDeals(d.dashboard.id)
    const fromSkill = service.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m1', component: 'deals', skill: 'crm' })
    if (!own.ok || !fromSkill.ok) throw new Error('add failed')
    expect(fromSkill.tile).toMatchObject({ component: 'deals', skill: 'crm' })
    expect(own.tile.skill).toBeNull()
    expect(service.resolveTile('p1', fromSkill.tile.id)?.view).toMatchObject({ state: 'ok', displayTitle: 'CRM deals', component: { skill: 'crm' } })
    expect(service.resolveTile('p1', own.tile.id)?.view).toMatchObject({ state: 'ok', displayTitle: 'Open deals', component: { skill: null } })
    expect(service.placements('p1', 'folder:m1').map((p) => [p.component, p.skill])).toEqual([['deals', null], ['deals', 'crm']])
    expect(service.components('folder:m1').map((c) => [c.skill, c.name])).toEqual([[null, 'broken'], [null, 'deals'], ['crm', 'deals']])
    expect(service.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m1', component: 'deals', skill: 'nope' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(service.addTile('p1', { dashboardId: d.dashboard.id, agentId: 'folder:m1', component: 'deals', skill: '../crm' })).toMatchObject({ ok: false, code: 'not_found' })
    skills = []
    expect(service.resolveTile('p1', fromSkill.tile.id)?.view).toMatchObject({ state: 'component_missing' })
    expect(service.resolveTile('p1', own.tile.id)?.view).toMatchObject({ state: 'ok' })
  })

  it('a D1 table gains the nullable skill column, existing rows reading null', () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    const t = addDeals(d.dashboard.id)
    if (!t.ok) throw new Error()
    holder.current!.raw.exec('ALTER TABLE dashboard_tiles DROP COLUMN skill')
    migrateDashboards(holder.current!.sqlite)
    migrateDashboards(holder.current!.sqlite)
    expect(holder.current!.raw.prepare('SELECT skill FROM dashboard_tiles WHERE id = ?').get(t.tile.id)).toEqual({ skill: null })
    expect(service.resolveTile('p1', t.tile.id)?.tile.skill).toBeNull()
  })
})

describe('credential readiness (D16)', () => {
  const slot = (over: object) => ({ name: 'gmail', type: 'api_key', optional: false, envPrefix: 'GMAIL_', expectedKeys: ['GMAIL_KEY'], presentKeys: [], attachment: null, satisfied: false, ...over })
  it('reuses the scan’s satisfied for a required slot, and judges an optional one by what it holds', () => {
    expect(credentialSlotReady(slot({ satisfied: true }))).toBe(true)
    expect(credentialSlotReady(slot({ satisfied: false }))).toBe(false)
    expect(credentialSlotReady(slot({ optional: true, satisfied: true }))).toBe(false)
    expect(credentialSlotReady(slot({ optional: true, satisfied: true, presentKeys: ['GMAIL_KEY'] }))).toBe(true)
    expect(credentialSlotReady(slot({ optional: true, satisfied: true, presentKeys: ['GMAIL_KEY'], attachment: { credentialId: 'c', state: 'expired' } }))).toBe(false)
  })
})

describe('agentBundleId', () => {
  it('reads the manifest’s bundle.bundle_id, else desktop.json’s shared_remote.bundle_id', () => {
    const dir = join(base, 'm1')
    expect(agentBundleId(dir, {})).toBeNull()
    mkdirSync(join(dir, 'app-data'), { recursive: true })
    writeFileSync(join(dir, 'app-data', 'desktop.json'), JSON.stringify({ shared_remote: { kind: 'cinna', clone_url: 'https://core.example/git/sales.git', bundle_id: 'io.example.shared' } }))
    expect(agentBundleId(dir, {})).toBe('io.example.shared')
    expect(agentBundleId(dir, { bundle: { bundle_id: 'io.example.manifest' } })).toBe('io.example.manifest')
  })
})

describe('resolveReference', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  const resolve = async (reference: string, chatAgentId?: string) => {
    const out = await service.resolveReference('p1', { reference, chatAgentId })
    if (!out.ok) throw new Error(out.message)
    return out.resolution
  }
  beforeEach(() => {
    agents.length = 0
    kitAgent(ID, { deals: list })
    agents[0].slug = 'sales'
  })

  it('finds a component by id, slug or bundle, with its placements and a canonical reference; reading runs nothing', async () => {
    const d = service.create('p1', 'Sales')
    if (!d.ok) throw new Error()
    service.addTile('p1', { dashboardId: d.dashboard.id, agentId: `folder:${ID}`, component: 'deals' })
    const byId = await resolve(`cinna://component/id:${ID.toUpperCase()}/deals`)
    expect(byId).toMatchObject({ found: true, component: { name: 'deals', agentId: `folder:${ID}`, valid: true }, canonicalReference: `cinna://component/id:${ID}/deals` })
    expect(byId.found && byId.placements.map((p) => p.dashboardName)).toEqual(['Sales'])
    expect(await resolve('cinna://component/sales/deals')).toMatchObject({ found: true, canonicalReference: `cinna://component/id:${ID}/deals` })
    agents[0].bundleId = () => 'io.example.sales'
    expect(await resolve('cinna://component/bundle:io.example.sales/deals')).toMatchObject({ found: true, canonicalReference: 'cinna://component/bundle:io.example.sales/deals' })
    expect(await resolve('cinna://component/sales/deals')).toMatchObject({ canonicalReference: 'cinna://component/bundle:io.example.sales/deals' })
  })

  it('resolves a skill’s component and says gone when the skill or component is not there', async () => {
    agents[0].skills = () => [{ name: 'crm', dir: cachedSkill('crm', { pipeline: list }) }]
    expect(await resolve(`cinna://component/id:${ID}/crm/pipeline`)).toMatchObject({ found: true, component: { skill: 'crm', name: 'pipeline' }, canonicalReference: `cinna://component/id:${ID}/crm/pipeline` })
    expect(await resolve(`cinna://component/id:${ID}/other/pipeline`)).toEqual({ found: false, reason: 'gone', agentName: agents[0].name, agentId: `folder:${ID}`, bundleId: null })
    expect(await resolve(`cinna://component/id:${ID}/missing`)).toMatchObject({ found: false, reason: 'gone' })
  })

  it('maps every miss to its reason', async () => {
    agents[0].bundleId = () => 'io.example.sales'
    expect(await resolve(`cinna://component/id:${OTHER}/deals`)).toEqual({ found: false, reason: 'agent_not_here', agentName: null, agentId: null, bundleId: null })
    expect(await resolve('cinna://component/nobody/deals')).toMatchObject({ found: false, reason: 'agent_not_here' })
    expect(await resolve('cinna://component/bundle:io.example.other/deals')).toEqual({ found: false, reason: 'bundle_not_installed', agentName: null, agentId: null, bundleId: 'io.example.other' })
    expect(await resolve('cinna://component/bundle:io.example.sales/missing')).toMatchObject({ found: false, reason: 'not_in_this_copy', agentId: `folder:${ID}` })
    others.push({ id: 'bare:x', manifestId: '', name: 'Notes folder', slug: 'notes' })
    expect(await resolve('cinna://component/notes/deals')).toMatchObject({ found: false, reason: 'not_kit_agent', agentName: 'Notes folder', agentId: 'bare:x' })
    expect(await service.resolveReference('p1', { reference: 'cinna://component/id:nope/deals' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.resolveReference('p1', { reference: 42 })).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('lets the chat’s own agent win a clash; two installs of one bundle are ambiguous elsewhere', async () => {
    kitAgent(OTHER, { deals: list })
    agents[1].slug = 'sales'
    for (const agent of agents) agent.bundleId = () => 'io.example.sales'
    for (const ref of ['cinna://component/sales/deals', 'cinna://component/bundle:io.example.sales/deals']) {
      expect(await resolve(ref)).toMatchObject({ found: false, reason: 'ambiguous' })
      expect(await resolve(ref, `folder:${OTHER}`)).toMatchObject({ found: true, component: { agentId: `folder:${OTHER}` } })
      expect(await resolve(ref, 'folder:unrelated')).toMatchObject({ found: false, reason: 'ambiguous' })
    }
  })
})

describe('panel chats (D3)', () => {
  it('finds the latest live chat of (dashboard, agent) for the owners, and deleting the dashboard keeps the chats without their origin', async () => {
    const { chatRepo } = await import('../../db/chats')
    const created = service.create('p1', 'Sales')
    if (!created.ok) throw new Error(created.message)
    const dashboardId = created.dashboard.id
    const older = chatRepo.create('p1', { agentId: 'folder:m1', originDashboardId: dashboardId })
    const newer = chatRepo.create('p1', { agentId: 'folder:m1', originDashboardId: dashboardId })
    holder.current!.raw.exec(`UPDATE chats SET updated_at = 100 WHERE id = '${older.id}'; UPDATE chats SET updated_at = 200 WHERE id = '${newer.id}';`)
    chatRepo.create('p1', { agentId: 'folder:other', originDashboardId: dashboardId })
    chatRepo.create('p1', { agentId: 'folder:m1' })
    const otherProfile = chatRepo.create('p2', { agentId: 'folder:m1', originDashboardId: dashboardId })
    holder.current!.raw.exec(`UPDATE chats SET updated_at = 50 WHERE id = '${otherProfile.id}';`)

    expect(chatRepo.latestFromDashboard('p1', dashboardId, 'folder:m1')?.id).toBe(newer.id)
    expect(chatRepo.latestFromDashboard(['p1', 'p2'], dashboardId, 'folder:m1')?.id).toBe(newer.id)
    expect(chatRepo.latestFromDashboard('p2', dashboardId, 'folder:m1')?.id).toBe(otherProfile.id)
    chatRepo.softDelete('p1', newer.id)
    expect(chatRepo.latestFromDashboard('p1', dashboardId, 'folder:m1')?.id).toBe(older.id)
    expect(chatRepo.latestFromDashboard('p1', 'other-dashboard', 'folder:m1')).toBeUndefined()
    expect(chatRepo.getOwned('p1', older.id)?.originDashboardId).toBe(dashboardId)

    expect(service.delete('p1', dashboardId)).toEqual({ ok: true })
    expect(chatRepo.getOwned('p1', older.id)).toMatchObject({ originDashboardId: null, deletedAt: null })
    expect(chatRepo.latestFromDashboard('p1', dashboardId, 'folder:m1')).toBeUndefined()
  })

  it('keeps a panel chat’s placeholder title as its title and as the initial one auto titling may replace', async () => {
    const { chatRepo } = await import('../../db/chats')
    const chat = chatRepo.create('p1', { agentId: 'folder:m1', initialTitle: 'Sales · Sales' })
    expect(chatRepo.getOwned('p1', chat.id)).toMatchObject({ title: 'Sales · Sales', initialTitle: 'Sales · Sales' })
    expect(chatRepo.getOwned('p1', chatRepo.create('p1').id)).toMatchObject({ title: 'New Chat', initialTitle: null })
    expect([service.agentName('folder:m1'), service.agentName('folder:nobody')]).toEqual(['Agent m1', null])
  })

  it('tells a kit agent from another local agent and from none', () => {
    others.push({ id: 'folder:bare', manifestId: 'bare', name: 'Bare', slug: 'bare' })
    expect([service.isComponentAgent('folder:m1'), service.isOtherLocalAgent('folder:m1')]).toEqual([true, false])
    expect([service.isComponentAgent('folder:bare'), service.isOtherLocalAgent('folder:bare')]).toEqual([false, true])
    expect([service.isComponentAgent('folder:nobody'), service.isOtherLocalAgent('folder:nobody')]).toEqual([false, false])
    expect([service.isComponentAgent(42), service.isOtherLocalAgent(42)]).toEqual([false, false])
  })
})
