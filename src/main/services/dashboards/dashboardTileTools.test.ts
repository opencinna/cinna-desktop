import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * `dashboards_tiles` and `dashboards_update_tile` over the real repository,
 * dashboard service and refresh service (with a scripted runner and clock):
 * which tiles an agent sees, how params merge and share the tile's budget,
 * and that a highlight is held, pushed and never counted.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))

/** `current` as the tools resolve it (local time). */
const thisMonth = (): string => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` }
vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent', nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }) }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: [] }), locate: () => { throw new Error('unused') } } }))
vi.mock('../../shell/env', () => ({ getShellEnv: async () => process.env, shellEnvForChild: (env: NodeJS.ProcessEnv) => env }))

const { createDashboardService } = await import('./dashboardService')
const { createDashboardRefreshService } = await import('./dashboardRefreshService')
const { dashboardRepo } = await import('../../db/dashboards')
const { createDashboardContextTracker } = await import('./dashboardContext')
const { createTileHighlights } = await import('./tileHighlights')
const { DashboardTileToolProvider } = await import('./dashboardTileTools')
const { DASHBOARD_CALLS_PER_MINUTE } = await import('../../../shared/dashboards')
type EndpointCall = import('./endpointRunner').EndpointCall
type DashboardContext = import('../../../shared/dashboards').DashboardContext

let base = ''
let clock = 1_000_000
const agents: Array<import('./componentScanner').ComponentAgent> = []
let runs: EndpointCall[] = []
let published: string[] = []
let pushed: Array<{ tileId: string; ids: string[] }> = []
let chat: { agentId: string | null; originDashboardId: string | null } | null = null
let dashboards: ReturnType<typeof createDashboardService>
let refresh: ReturnType<typeof createDashboardRefreshService>
let tracker: ReturnType<typeof createDashboardContextTracker>
let highlights: ReturnType<typeof createTileHighlights>
let dashboardId = ''
const tiles: Record<string, string> = {}

function write(agent: string, rel: string, content: string): void {
  const file = join(base, agent, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function add(agentId: string, component: string): string {
  const added = dashboards.addTile('p1', { dashboardId, agentId, component })
  if (!added.ok) throw new Error(added.message)
  return added.tile.id
}

function provider(agentId = 'folder:m1') {
  return new DashboardTileToolProvider({ profileUserId: 'p1', chatId: 'chat-1', agentId }, {
    chat: () => chat,
    dashboard: (userId, id) => dashboardRepo.get(userId, id),
    tiles: (userId, id) => dashboards.resolvedTiles(userId, id),
    setParams: (userId, input) => refresh.setParams(userId, input),
    retryAfterSeconds: (tileId) => refresh.retryAfterSeconds(tileId),
    lastContext: (chatId) => tracker.lastContext(chatId),
    highlights,
    publishHighlight: (tileId, ids) => pushed.push({ tileId, ids })
  })
}

async function call(name: string, input: Record<string, unknown>, agentId?: string) {
  const result = await provider(agentId).callTool(name, input)
  return { result, body: result.isError ? null : JSON.parse(result.content as string) as Record<string, any> }
}

/** The error result as the schema states it: isError, the message as text, structuredContent.error. */
function expectError(result: { isError?: boolean; content: unknown; structuredContent?: Record<string, unknown> }, error: Record<string, unknown>): void {
  expect(result.isError).toBe(true)
  const structured = result.structuredContent as { error: { message: string } }
  expect(structured.error).toMatchObject(error)
  expect(result.content).toBe(structured.error.message)
  expect(Object.keys(structured)).toEqual(['error'])
}

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('p1', 'cinna_user', 'p1', 'P1', 1);`)
  base = mkdtempSync(join(tmpdir(), 'dash-tools-'))
  clock = 1_000_000
  runs = []
  published = []
  pushed = []
  agents.length = 0
  agents.push({ id: 'folder:m1', manifestId: 'm1', name: 'Sales', path: join(base, 'm1') })
  agents.push({ id: 'folder:m2', manifestId: 'm2', name: 'Ops', path: join(base, 'm2') })
  write('m1', 'dashboards/deals/component.json', JSON.stringify({
    schema_version: 1, title: 'Deals', view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } },
    params: { month: { type: 'month', default: 'current' }, stage: { type: 'enum', label: 'Stage', values: ['lead', 'won'], default: 'lead' }, owner: { type: 'text' } }
  }))
  write('m1', 'dashboards/deals/api/data.py', 'print("{}")')
  write('m1', 'dashboards/board/component.json', JSON.stringify({
    schema_version: 1, title: 'Board', view: 'html', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }
  }))
  write('m1', 'dashboards/board/index.html', '<html><body></body></html>')
  write('m1', 'dashboards/board/api/data.py', 'print("{}")')
  write('m1', 'dashboards/status/component.json', JSON.stringify({ schema_version: 1, title: 'Status', view: 'markdown', source: { file: 'app-data/status.md' } }))
  write('m1', 'app-data/status.md', '# ok')
  write('m2', 'dashboards/notes/component.json', JSON.stringify({ schema_version: 1, title: 'Notes', view: 'markdown', source: { file: 'app-data/notes.md' } }))
  write('m2', 'app-data/notes.md', '# notes')
  dashboards = createDashboardService({ agents: () => agents })
  refresh = createDashboardRefreshService({
    dashboards,
    runner: { run: (call) => { runs.push(call); return new Promise(() => {}) } },
    runCommand: async () => ({ ok: true, busy: false, aborted: false }),
    publish: (id) => published.push(id),
    now: () => clock
  })
  tracker = createDashboardContextTracker()
  highlights = createTileHighlights()
  const created = dashboards.create('p1', 'Sales')
  if (!created.ok) throw new Error(created.message)
  dashboardId = created.dashboard.id
  tiles.deals = add('folder:m1', 'deals')
  tiles.notes = add('folder:m2', 'notes')
  tiles.board = add('folder:m1', 'board')
  tiles.status = add('folder:m1', 'status')
  chat = { agentId: 'folder:m1', originDashboardId: dashboardId }
})
afterEach(() => {
  holder.current?.close()
  rmSync(base, { recursive: true, force: true })
})

describe('dashboards_tiles', () => {
  it('lists only the calling agent’s tiles, in order, with defaults filled in and current/today resolved', async () => {
    const { body } = await call('dashboards_tiles', {})
    expect(body!.dashboard).toEqual({ id: dashboardId, name: 'Sales' })
    expect(body!.tiles.map((tile: { tile_id: string }) => tile.tile_id)).toEqual([tiles.deals, tiles.board, tiles.status])
    expect(body!.tiles[0]).toEqual({
      tile_id: tiles.deals,
      component: 'deals',
      title: 'Deals',
      view: 'list',
      params: { month: thisMonth(), stage: 'lead' },
      param_specs: { month: { type: 'month', default: 'current' }, stage: { type: 'enum', label: 'Stage', values: ['lead', 'won'], default: 'lead' }, owner: { type: 'text' } },
      can_highlight: true
    })
    expect(body!.tiles[1]).toMatchObject({ view: 'html', params: {}, param_specs: {}, can_highlight: false })
    expect(body!.tiles[2]).toMatchObject({ view: 'markdown', can_highlight: false })
    // The other agent sees only its own tile.
    const other = await call('dashboards_tiles', {}, 'folder:m2')
    chat = { agentId: 'folder:m2', originDashboardId: dashboardId }
    expect((await call('dashboards_tiles', {}, 'folder:m2')).body!.tiles.map((tile: { tile_id: string }) => tile.tile_id)).toEqual([tiles.notes])
    expectError(other.result, { code: 'no_dashboard' })
  })

  it('says a page can highlight once it signalled ready', async () => {
    highlights.markReady(tiles.board)
    const { body } = await call('dashboards_tiles', {})
    expect(body!.tiles[1]).toMatchObject({ tile_id: tiles.board, can_highlight: true })
  })

  it('gives summary and selection only for the tile the last delivered context focused', async () => {
    expect((await call('dashboards_tiles', {})).body!.tiles[0]).not.toHaveProperty('summary')
    const context: DashboardContext = {
      dashboardId, dashboard: 'Sales', alsoYours: [], otherTiles: [],
      focused: { tileId: tiles.deals, component: 'deals', skill: null, title: 'Deals', params: {}, selection: ['d-17'], dataAge: null, summary: '3 open deals' }
    }
    const turn = tracker.forTurn('chat-1', 'SECTION', context)
    // Not delivered yet: nothing known.
    expect((await call('dashboards_tiles', {})).body!.tiles[0]).not.toHaveProperty('summary')
    turn.delivered()
    const { body } = await call('dashboards_tiles', {})
    expect(body!.tiles[0]).toMatchObject({ summary: '3 open deals', selection: ['d-17'] })
    expect(body!.tiles[0]).not.toHaveProperty('visible')
    expect(body!.tiles[1]).not.toHaveProperty('summary')
    expect(body!.tiles[1]).not.toHaveProperty('selection')
  })

  it('answers no_dashboard for a chat without one, a deleted dashboard, or another agent’s chat', async () => {
    chat = { agentId: 'folder:m1', originDashboardId: null }
    expectError((await call('dashboards_tiles', {})).result, { code: 'no_dashboard' })
    chat = { agentId: 'folder:m2', originDashboardId: dashboardId }
    expectError((await call('dashboards_tiles', {})).result, { code: 'no_dashboard' })
    chat = { agentId: 'folder:m1', originDashboardId: dashboardId }
    dashboards.delete('p1', dashboardId)
    expectError((await call('dashboards_tiles', {})).result, { code: 'no_dashboard' })
    expectError((await call('dashboards_update_tile', { tile_id: tiles.deals, highlight: ['a'] })).result, { code: 'no_dashboard' })
  })
})

describe('dashboards_update_tile', () => {
  it('answers not_found for another agent’s tile and an unknown id, never forbidden', async () => {
    const notes = await call('dashboards_update_tile', { tile_id: tiles.notes, highlight: ['x'] })
    expectError(notes.result, { code: 'not_found' })
    expectError((await call('dashboards_update_tile', { tile_id: 'nope', params: { stage: 'won' } })).result, { code: 'not_found' })
    expect(pushed).toEqual([])
  })

  it('merges params over the stored set, null going back to the default, and recomputes', async () => {
    const first = await call('dashboards_update_tile', { tile_id: tiles.deals, params: { stage: 'won', owner: 'ann' } })
    expect(first.body).toEqual({ tile_id: tiles.deals, params: { month: thisMonth(), stage: 'won', owner: 'ann' }, recomputing: true, highlighted: false })
    expect(dashboards.resolveTile('p1', tiles.deals)!.tile.params).toEqual({ month: 'current', stage: 'won', owner: 'ann' })
    expect(published).toContain(tiles.deals)
    expect(runs).toHaveLength(1)
    expect(runs[0].params).toMatchObject({ stage: 'won', owner: 'ann' })

    const second = await call('dashboards_update_tile', { tile_id: tiles.deals, params: { owner: null, stage: null, month: '2026-09' } })
    expect(second.body).toEqual({ tile_id: tiles.deals, params: { month: '2026-09', stage: 'lead' }, recomputing: true, highlighted: false })
    expect(dashboards.resolveTile('p1', tiles.deals)!.tile.params).toEqual({ month: '2026-09' })
  })

  it('runs nothing when the params do not change', async () => {
    const same = await call('dashboards_update_tile', { tile_id: tiles.deals, params: { month: 'current', stage: 'lead' } })
    expect(same.body).toEqual({ tile_id: tiles.deals, params: { month: thisMonth(), stage: 'lead' }, recomputing: false, highlighted: false })
    expect(runs).toHaveLength(0)
    expect(published).toEqual([])
  })

  it('treats a value echoed back as dashboards_tiles reported it (current resolved, a default) as unchanged', async () => {
    const echo = await call('dashboards_update_tile', { tile_id: tiles.deals, params: { month: thisMonth(), stage: 'lead' } })
    expect(echo.body).toMatchObject({ recomputing: false })
    expect(runs).toHaveLength(0)
    expect(dashboards.resolveTile('p1', tiles.deals)!.tile.params).toEqual({ month: 'current', stage: 'lead' })
    // With a real change beside it, the tile keeps its word and follows the calendar.
    const edit = await call('dashboards_update_tile', { tile_id: tiles.deals, params: { month: thisMonth(), stage: 'won' } })
    expect(edit.body).toMatchObject({ recomputing: true })
    expect(dashboards.resolveTile('p1', tiles.deals)!.tile.params).toEqual({ month: 'current', stage: 'won' })
  })

  it('refuses a bad value, an undeclared param, no change asked for, and a malformed input as invalid_input', async () => {
    expectError((await call('dashboards_update_tile', { tile_id: tiles.deals, params: { stage: 'lost' } })).result,
      { code: 'invalid_input', field: 'params.stage', message: 'Stage must be one of lead, won.' })
    expectError((await call('dashboards_update_tile', { tile_id: tiles.deals, params: { region: 'eu' } })).result, { code: 'invalid_input', field: 'params.region' })
    expectError((await call('dashboards_update_tile', { tile_id: tiles.deals })).result, { code: 'invalid_input' })
    expectError((await call('dashboards_update_tile', { tile_id: 7, highlight: [] })).result, { code: 'invalid_input', field: 'tile_id' })
    expectError((await call('dashboards_update_tile', { tile_id: tiles.deals, highlight: [''] })).result, { code: 'invalid_input', field: 'highlight' })
    expectError((await call('dashboards_update_tile', { tile_id: tiles.deals, params: { stage: { a: 1 } } })).result, { code: 'invalid_input', field: 'params.stage' })
    expectError((await call('dashboards_update_tile', { tile_id: tiles.deals, visibility: 'all' })).result, { code: 'invalid_input', field: 'visibility' })
    expect(runs).toHaveLength(0)
    expect(dashboards.resolveTile('p1', tiles.deals)!.tile.params).toEqual({ month: 'current', stage: 'lead' })
  })

  it('shares the tile’s budget with the owner’s filters: rate_limited with retry_after_s, nothing stored', async () => {
    for (let i = 0; i < DASHBOARD_CALLS_PER_MINUTE - 1; i++) {
      clock += 1_000
      expect(await refresh.setParams('p1', { tileId: tiles.deals, params: { stage: i % 2 ? 'lead' : 'won' } })).toMatchObject({ ok: true })
    }
    // Highlight-only calls in between never count.
    for (let i = 0; i < 5; i++) expect((await call('dashboards_update_tile', { tile_id: tiles.deals, highlight: [`d-${i}`] })).result.isError).toBeFalsy()
    const last = await call('dashboards_update_tile', { tile_id: tiles.deals, params: { owner: 'ann' } })
    expect(last.body).toMatchObject({ recomputing: true })
    const before = dashboards.resolveTile('p1', tiles.deals)!.tile.params
    const refused = await call('dashboards_update_tile', { tile_id: tiles.deals, params: { owner: 'bob' }, highlight: ['d-9'] })
    // The oldest of the minute's runs was at +1s and frees up at +61s; the clock is at +29s.
    expectError(refused.result, { code: 'rate_limited', retry_after_s: 32 })
    expect(dashboards.resolveTile('p1', tiles.deals)!.tile.params).toEqual(before)
    expect(highlights.get(tiles.deals)).toEqual(['d-4'])
    // Still only a highlight: let through over the budget.
    expect((await call('dashboards_update_tile', { tile_id: tiles.deals, highlight: ['d-9'] })).body).toMatchObject({ highlighted: true, recomputing: false })
  })

  it('holds and pushes a highlight; highlighted only when ids are given and the tile draws them', async () => {
    const list = await call('dashboards_update_tile', { tile_id: tiles.deals, highlight: ['d-1', 'd-2'] })
    expect(list.body).toEqual({ tile_id: tiles.deals, params: { month: thisMonth(), stage: 'lead' }, recomputing: false, highlighted: true })
    expect(highlights.get(tiles.deals)).toEqual(['d-1', 'd-2'])
    expect(pushed).toEqual([{ tileId: tiles.deals, ids: ['d-1', 'd-2'] }])

    const cleared = await call('dashboards_update_tile', { tile_id: tiles.deals, highlight: [] })
    expect(cleared.body).toMatchObject({ highlighted: false })
    expect(highlights.get(tiles.deals)).toEqual([])
    expect(pushed.at(-1)).toEqual({ tileId: tiles.deals, ids: [] })

    expect((await call('dashboards_update_tile', { tile_id: tiles.status, highlight: ['a'] })).body).toMatchObject({ highlighted: false })
    expect((await call('dashboards_update_tile', { tile_id: tiles.board, highlight: ['a'] })).body).toMatchObject({ highlighted: false })
    // Held for the page all the same, for when it says it listens.
    expect(highlights.get(tiles.board)).toEqual(['a'])
    highlights.markReady(tiles.board)
    expect((await call('dashboards_update_tile', { tile_id: tiles.board, highlight: ['a'] })).body).toMatchObject({ highlighted: true })
    expect((await call('dashboards_update_tile', { tile_id: tiles.deals, params: { stage: 'won' } })).body).toMatchObject({ highlighted: false, recomputing: true })
    expect(runs).toHaveLength(1)
  })
})
