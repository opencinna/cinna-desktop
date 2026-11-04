import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../../db/testSupport/nodeSqlite'

/** The backing core dashboard (D6.1): made once, checked, made again when gone, and core's refresh shape. */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../../../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
vi.mock('../../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../../cinna-http', () => ({ cinnaSend: vi.fn(async () => { throw new Error('no network in tests') }) }))

const { createBackingDashboards, refreshToCore } = await import('./backingDashboards')
const { dashboardRepo } = await import('../../../db/dashboards')

const ok = <T,>(value: T) => ({ ok: true as const, value })
let client: Record<string, ReturnType<typeof vi.fn>>
let server: string | null

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('p1', 'cinna_user', 'p1', 'P1', 1);`)
  server = 'https://cinna.example.com'
  client = {
    createDashboard: vi.fn(async (_u: string, name: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return ok({ id: 'core-d1', name, blocks: [] })
    }),
    getDashboard: vi.fn(async () => ok({ id: 'core-d1', name: 'Ops', blocks: [] })),
    renameDashboard: vi.fn(async () => ok({})),
    deleteDashboard: vi.fn(async () => ok({})),
    updateBlock: vi.fn(async () => ok({})),
    deleteBlock: vi.fn(async () => ok({}))
  }
})
afterEach(() => holder.current?.close())

describe('backing dashboards', () => {
  it('makes one core dashboard for two adds at once, and records it with the server', async () => {
    const backing = createBackingDashboards({ client: client as never, serverUrl: () => server })
    const dashboard = dashboardRepo.create('p1', 'Ops')
    const [a, b] = await Promise.all([backing.ensure('p1', dashboard.id), backing.ensure('p1', dashboard.id)])
    expect(a).toEqual({ ok: true, coreDashboardId: 'core-d1' })
    expect(b).toEqual(a)
    expect(client.createDashboard).toHaveBeenCalledTimes(1)
    expect(dashboardRepo.get('p1', dashboard.id)).toMatchObject({ coreDashboardId: 'core-d1', coreServer: 'https://cinna.example.com' })
    expect(await backing.ensure('p1', dashboard.id)).toEqual(a)
    expect(client.createDashboard).toHaveBeenCalledTimes(1)
    server = 'https://other.example.org'
    expect(await backing.ensure('p1', dashboard.id)).toMatchObject({ ok: false, code: 'wrong_server' })
    server = null
    expect(await backing.ensure('p1', dashboard.id)).toMatchObject({ ok: false, code: 'reauth_required' })
  })

  it('maps Edit tile’s refresh override to core’s block config, keeping Manual and on-app-start on the desktop', () => {
    expect(refreshToCore(null)).toEqual({})
    expect(refreshToCore({ manual: true, onAppStart: true })).toEqual({})
    expect(refreshToCore({ maxAge: '30m', whileOpenEvery: '2m', afterTurn: false })).toEqual({ max_age: '30m', while_open_every: '2m', after_turn: false })
    // "Interval off" on the desktop is core's "manual" (null there means "the component's").
    expect(refreshToCore({ whileOpenEvery: null })).toEqual({ while_open_every: 'manual' })
  })
})
