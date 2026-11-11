import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'

/**
 * The refresh policy over the real repository and real component folders,
 * with a scripted endpoint runner and clock: when a tile recomputes, what is
 * kept when it fails, joins, the lease and the profile-close cancel.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent', nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }) }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: [] }), locate: () => { throw new Error('unused') } } }))
vi.mock('../../shell/env', () => ({ getShellEnv: async () => process.env, shellEnvForChild: (env: NodeJS.ProcessEnv) => env }))

const { createDashboardService } = await import('./dashboardService')
const { createDashboardRefreshService, MAX_CACHED_RESULT_BYTES, MAX_LEASED_TILES } = await import('./dashboardRefreshService')
const { DASHBOARD_LEASE_TTL_MS } = await import('../../../shared/dashboards')
type EndpointOutcome = import('./endpointRunner').EndpointOutcome
type EndpointCall = import('./endpointRunner').EndpointCall

let base = ''
let clock = 1_000_000
const agents: Array<import('./componentScanner').ComponentAgent> = []

function writeAgentFile(rel: string, content: string): void {
  const file = join(base, 'agent', rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** A runner whose calls the test settles, one by one. */
function scriptedRunner() {
  const calls: Array<{ call: EndpointCall; settle: (o: EndpointOutcome) => void }> = []
  return {
    calls,
    runner: {
      run: (call: EndpointCall) => new Promise<EndpointOutcome>((resolve) => {
        call.signal?.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled', message: 'cancelled', durationMs: 0 }), { once: true })
        calls.push({ call, settle: resolve })
      })
    }
  }
}

const ok = (value: unknown): EndpointOutcome => ({ ok: true, value, durationMs: 7 })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

let runner: ReturnType<typeof scriptedRunner>
let runCommand: Mock<(...args: any[]) => any>
let published: string[]
let dashboards: ReturnType<typeof createDashboardService>
let refresh: ReturnType<typeof createDashboardRefreshService>
let tileId = ''

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('p1', 'cinna_user', 'p1', 'P1', 1), ('p2', 'cinna_user', 'p2', 'P2', 1);`)
  base = mkdtempSync(join(tmpdir(), 'dash-refresh-'))
  clock = 1_000_000
  agents.length = 0
  agents.push({ id: 'folder:m1', manifestId: 'm1', name: 'Sales', path: join(base, 'agent') })
  writeAgentFile('dashboards/deals/component.json', JSON.stringify({
    schema_version: 1, title: 'Deals', view: 'list', source: { endpoint: 'data' },
    endpoints: { data: { script: 'api/data.py', timeout_s: 20 } }, refresh: { max_age: '15m' }, params: { month: { type: 'month', default: 'current' } }
  }))
  writeAgentFile('dashboards/deals/api/data.py', 'print("{}")')
  writeAgentFile('dashboards/status/component.json', JSON.stringify({
    schema_version: 1, title: 'Status', view: 'markdown', source: { file: 'app-data/status.md' }, refresh: { command: '/run:update-status' }
  }))
  writeAgentFile('app-data/status.md', '# All good')
  runner = scriptedRunner()
  runCommand = vi.fn(async () => ({ ok: true, busy: false, aborted: false }))
  published = []
  dashboards = createDashboardService({ agents: () => agents })
  refresh = createDashboardRefreshService({ dashboards, runner: runner.runner, runCommand, publish: (id) => published.push(id), now: () => clock })
  const d = dashboards.addTile('p1', { newDashboardName: 'Sales', agentId: 'folder:m1', component: 'deals' })
  if (!d.ok) throw new Error(d.message)
  tileId = d.tile.id
})
afterEach(() => {
  holder.current?.close()
  rmSync(base, { recursive: true, force: true })
})

async function settleNext(outcome: EndpointOutcome): Promise<void> {
  await tick()
  runner.calls[runner.calls.length - 1].settle(outcome)
  await tick()
  await tick()
}

describe('ensureFresh', () => {
  it('recomputes a visible tile with no data, then only once it is older than its max age', async () => {
    const first = await refresh.ensureFresh('p1', tileId, 'visible')
    expect(first).toMatchObject({ ok: true, result: { data: null, refreshing: true } })
    expect(runner.calls[0].call).toMatchObject({
      agentId: 'folder:m1', script: 'dashboards/deals/api/data.py', runtime: 'python', timeoutS: 20, key: `${tileId}:data`
    })
    // `current` reaches the endpoint as the month itself, never the word.
    const at = new Date(clock)
    expect(runner.calls[0].call.params).toEqual({ month: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}` })
    await settleNext(ok({ items: [{ id: 'd1', title: 'Acme' }], notice: 'Token expires soon' }))
    expect(refresh.tileResult('p1', tileId)).toMatchObject({ ok: true, result: { data: { items: [{ id: 'd1' }] }, fetchedAt: clock, error: null, refreshing: false, stale: false, notice: 'Token expires soon' } })
    expect(published).toEqual([tileId, tileId])

    clock += 14 * 60_000
    await refresh.ensureFresh('p1', tileId, 'visible')
    expect(runner.calls).toHaveLength(1)
    clock += 2 * 60_000
    expect(refresh.tileResult('p1', tileId)).toMatchObject({ ok: true, result: { stale: true } })
    await refresh.ensureFresh('p1', tileId, 'visible')
    expect(runner.calls).toHaveLength(2)
  })

  it('recomputes on Refresh whatever the age', async () => {
    await refresh.ensureFresh('p1', tileId, 'visible')
    await settleNext(ok({ items: [] }))
    await refresh.ensureFresh('p1', tileId, 'manual')
    expect(runner.calls).toHaveLength(2)
  })

  it('keeps the last good data when a run fails, and the error beside it, retried once per max age', async () => {
    await refresh.ensureFresh('p1', tileId, 'visible')
    await settleNext(ok({ items: [{ id: 'd1', title: 'Acme' }] }))
    await refresh.ensureFresh('p1', tileId, 'manual')
    await settleNext({ ok: false, code: 'failed', message: 'The endpoint exited with code 1: boom', durationMs: 3 })
    expect(refresh.tileResult('p1', tileId)).toMatchObject({ ok: true, result: { data: { items: [{ id: 'd1' }] }, error: 'The endpoint exited with code 1: boom' } })
    await refresh.ensureFresh('p1', tileId, 'visible')
    expect(runner.calls).toHaveLength(2)
    await refresh.ensureFresh('p1', tileId, 'manual')
    await settleNext(ok({ items: [] }))
    expect(refresh.tileResult('p1', tileId)).toMatchObject({ ok: true, result: { data: { items: [] }, error: null } })
  })

  it('keeps the data with no error when the agent is busy, the run was replaced or an editor write preempted it', async () => {
    await refresh.ensureFresh('p1', tileId, 'visible')
    await settleNext(ok({ items: [] }))
    for (const code of ['busy', 'superseded', 'interrupted'] as const) {
      await refresh.ensureFresh('p1', tileId, 'manual')
      await settleNext({ ok: false, code, message: code, durationMs: 0 })
      expect(refresh.tileResult('p1', tileId)).toMatchObject({ ok: true, result: { data: { items: [] }, error: null } })
    }
  })

  it('joins a run already in flight for the same params', async () => {
    await refresh.ensureFresh('p1', tileId, 'manual')
    await refresh.ensureFresh('p1', tileId, 'manual')
    await refresh.ensureFresh('p1', tileId, 'visible')
    await tick()
    expect(runner.calls).toHaveLength(1)
    expect(refresh.inFlightCount()).toBe(1)
    await settleNext(ok({ items: [] }))
    expect(refresh.inFlightCount()).toBe(0)
  })

  it('leaves a Manual tile alone once it has data', async () => {
    dashboards.updateTile('p1', { tileId, refreshOverride: { manual: true } })
    await refresh.ensureFresh('p1', tileId, 'visible')
    await settleNext(ok({ items: [] }))
    clock += 24 * 3_600_000
    await refresh.ensureFresh('p1', tileId, 'visible')
    expect(runner.calls).toHaveLength(1)
    await refresh.ensureFresh('p1', tileId, 'manual')
    expect(runner.calls).toHaveLength(2)
  })

  it('shows a result over the cache limit without keeping it', async () => {
    await refresh.ensureFresh('p1', tileId, 'visible')
    const big = { items: [{ id: 'x', title: 'y'.repeat(MAX_CACHED_RESULT_BYTES) }] }
    await settleNext(ok(big))
    expect(refresh.tileResult('p1', tileId)).toMatchObject({ ok: true, result: { tooLarge: true, data: big } })
    expect(holder.current!.raw.prepare('SELECT result_json, too_large FROM dashboard_tile_results').get()).toEqual({ result_json: null, too_large: 1 })
  })

  it('reads a file source after its refresh command, through the yielding /run:', async () => {
    const t = dashboards.addTile('p1', { newDashboardName: 'Ops', agentId: 'folder:m1', component: 'status' })
    if (!t.ok) throw new Error(t.message)
    await refresh.ensureFresh('p1', t.tile.id, 'visible', { wait: true })
    expect(runCommand).toHaveBeenCalledWith('folder:m1', 'update-status', expect.any(AbortSignal))
    expect(refresh.tileResult('p1', t.tile.id)).toMatchObject({ ok: true, result: { data: { markdown: '# All good' } } })
    runCommand.mockResolvedValueOnce({ ok: false, busy: true, aborted: false })
    writeAgentFile('app-data/status.md', '# Changed')
    await refresh.ensureFresh('p1', t.tile.id, 'manual', { wait: true })
    expect(refresh.tileResult('p1', t.tile.id)).toMatchObject({ ok: true, result: { data: { markdown: '# All good' }, error: null } })
    runCommand.mockResolvedValueOnce({ ok: false, busy: false, aborted: false, error: '"x" exited with code 2.' })
    await refresh.ensureFresh('p1', t.tile.id, 'manual', { wait: true })
    expect(refresh.tileResult('p1', t.tile.id)).toMatchObject({ ok: true, result: { data: { markdown: '# All good' }, error: '"x" exited with code 2.' } })
  })

  it('redacts a file source’s values before caching or showing them', async () => {
    const { rememberCredentialSecrets, clearCredentialRedaction } = await import('../../security/serviceCredentialRedaction')
    rememberCredentialSecrets({ api_key: 'sk-file-secret-value' })
    try {
      writeAgentFile('app-data/status.md', 'token sk-file-secret-value here')
      const t = dashboards.addTile('p1', { newDashboardName: 'Ops', agentId: 'folder:m1', component: 'status' })
      if (!t.ok) throw new Error(t.message)
      await refresh.ensureFresh('p1', t.tile.id, 'visible', { wait: true })
      expect(refresh.tileResult('p1', t.tile.id)).toMatchObject({ ok: true, result: { data: { markdown: 'token ***REDACTED*** here' } } })
      expect(JSON.stringify(holder.current!.raw.prepare('SELECT result_json FROM dashboard_tile_results').all())).not.toContain('sk-file-secret-value')
    } finally {
      clearCredentialRedaction()
    }
  })

  it('answers not_found for another profile’s tile and runs nothing', async () => {
    expect(await refresh.ensureFresh('p2', tileId, 'manual')).toMatchObject({ ok: false, code: 'not_found' })
    expect(refresh.tileResult('p2', tileId)).toMatchObject({ ok: false, code: 'not_found' })
    await tick()
    expect(runner.calls).toHaveLength(0)
  })

  it('runs nothing for a tile whose component broke', async () => {
    writeAgentFile('dashboards/deals/component.json', '{}')
    expect(await refresh.ensureFresh('p1', tileId, 'manual')).toMatchObject({ ok: true, result: { data: null } })
    await tick()
    expect(runner.calls).toHaveLength(0)
  })
})

describe('the lease and the profile', () => {
  it('re-checks leased tiles on renewal, expires after its TTL and drops on hide', async () => {
    expect(refresh.renewLease('p1', [tileId])).toEqual({ ok: true })
    await tick()
    expect(runner.calls).toHaveLength(1)
    expect(refresh.isLeased(tileId)).toBe(true)
    clock += DASHBOARD_LEASE_TTL_MS + 1
    expect(refresh.isLeased(tileId)).toBe(false)
    refresh.renewLease('p1', [tileId])
    expect(refresh.dropLease('p1')).toEqual({ ok: true })
    expect(refresh.isLeased(tileId)).toBe(false)
    expect(refresh.renewLease('p1', 'nope')).toMatchObject({ ok: false, code: 'invalid_input' })
  })

  it('dedupes a renewal and takes at most MAX_LEASED_TILES ids, ignoring the rest', async () => {
    const ids = [tileId, tileId, ...Array.from({ length: MAX_LEASED_TILES + 50 }, (_, i) => `ghost-${i}`)]
    expect(refresh.renewLease('p1', ids)).toEqual({ ok: true })
    await tick()
    expect(runner.calls).toHaveLength(1)
    expect(refresh.isLeased(tileId)).toBe(true)
    expect(refresh.isLeased(`ghost-${MAX_LEASED_TILES - 2}`)).toBe(true)
    expect(refresh.isLeased(`ghost-${MAX_LEASED_TILES - 1}`)).toBe(false)
  })

  it('cancels every run on profile close, and records nothing from it', async () => {
    await refresh.ensureFresh('p1', tileId, 'manual')
    await tick()
    expect(runner.calls[0].call.signal?.aborted).toBe(false)
    refresh.cancelAll()
    expect(runner.calls[0].call.signal?.aborted).toBe(true)
    await tick(); await tick()
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM dashboard_tile_results').get()).toEqual({ n: 0 })
    expect(refresh.inFlightCount()).toBe(0)
  })

  it('cancelAll resolves only once every run and preview has ended', async () => {
    await refresh.ensureFresh('p1', tileId, 'manual')
    const preview = refresh.preview('p1', 'folder:m1', 'deals')
    await tick()
    expect(runner.calls).toHaveLength(2)
    let done = false
    const cancelled = refresh.cancelAll().then(() => { done = true })
    expect(runner.calls.every((c) => c.call.signal?.aborted)).toBe(true)
    await cancelled
    expect(done).toBe(true)
    expect(refresh.inFlightCount()).toBe(0)
    await preview
  })

  it('previews a component once, uncached', async () => {
    const preview = refresh.preview('p1', 'folder:m1', 'deals')
    await settleNext(ok({ items: [{ id: 'p' }] }))
    expect(await preview).toMatchObject({ ok: true, result: { data: { items: [{ id: 'p' }] }, error: null } })
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM dashboard_tile_results').get()).toEqual({ n: 0 })
    expect(await refresh.preview('p1', 'folder:m1', 'missing')).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('credentials (D16)', () => {
  it('spawns nothing while a required credential is not ready, and names it; the cached data stays', async () => {
    await refresh.ensureFresh('p1', tileId, 'visible')
    await settleNext(ok({ items: [{ id: 'd1', title: 'Acme' }] }))
    writeAgentFile('cinna-agent.json', JSON.stringify({ id: 'm1', credentials: [{ name: 'gmail' }, { name: 'stripe' }] }))
    writeAgentFile('dashboards/deals/component.json', JSON.stringify({
      schema_version: 1, title: 'Deals', view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, requires_credentials: ['gmail', 'stripe']
    }))
    agents[0].credentialSlots = [{ name: 'gmail', ready: false }, { name: 'stripe', ready: false }]
    const fresh = await refresh.ensureFresh('p1', tileId, 'manual')
    expect(fresh).toMatchObject({ ok: true, result: { data: { items: [{ id: 'd1' }] }, refreshing: false } })
    expect(fresh.ok && fresh.result.error).toMatch(/“gmail” and “stripe” credentials/)
    const preview = await refresh.preview('p1', 'folder:m1', 'deals')
    expect(preview).toMatchObject({ ok: true, result: { data: null } })
    expect(preview.ok && preview.result.error).toMatch(/“gmail” and “stripe”/)
    expect(runner.calls).toHaveLength(1)
    agents[0].credentialSlots = [{ name: 'gmail', ready: true }, { name: 'stripe', ready: true }]
    await refresh.ensureFresh('p1', tileId, 'manual')
    expect(runner.calls).toHaveLength(2)
  })
})

describe('skill-shipped components (D15)', () => {
  it('run the script from the skill’s folder, with cwd and credentials at the agent', async () => {
    const skillDir = join(base, 'cache', 'crm')
    mkdirSync(join(skillDir, 'dashboards', 'pipeline', 'api'), { recursive: true })
    writeFileSync(join(skillDir, 'dashboards', 'pipeline', 'component.json'), JSON.stringify({
      schema_version: 1, title: 'Pipeline', view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }
    }))
    writeFileSync(join(skillDir, 'dashboards', 'pipeline', 'api', 'data.py'), 'print("{}")')
    agents[0].skills = () => [{ name: 'crm', dir: skillDir }]
    const preview = refresh.preview('p1', 'folder:m1', 'pipeline', 'crm')
    await tick()
    const { call } = runner.calls[0]
    expect(call).toMatchObject({ agentId: 'folder:m1', agentDir: join(base, 'agent') })
    expect(call.script).toBe(join(realpathSync(skillDir), 'dashboards', 'pipeline', 'api', 'data.py'))
    runner.calls[0].settle(ok({ items: [] }))
    expect(await preview).toMatchObject({ ok: true, result: { data: { items: [] } } })
    expect(await refresh.preview('p1', 'folder:m1', 'pipeline')).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('after a turn (D3)', () => {
  /** A second component of the agent that asks for `after_turn`, placed beside `deals`. */
  function addAfterTurnTile(): string {
    writeAgentFile('dashboards/pipeline/component.json', JSON.stringify({
      schema_version: 1, title: 'Pipeline', view: 'list', source: { endpoint: 'data' },
      endpoints: { data: { script: 'api/data.py' } }, refresh: { max_age: '1d', after_turn: true }
    }))
    writeAgentFile('dashboards/pipeline/api/data.py', 'print("{}")')
    const dashboardId = dashboards.list('p1')[0].id
    const added = dashboards.addTile('p1', { dashboardId, agentId: 'folder:m1', component: 'pipeline' })
    if (!added.ok) throw new Error(added.message)
    return added.tile.id
  }

  it('re-runs only the agent’s leased tiles whose component says after_turn, even when fresh', async () => {
    const pipeline = addAfterTurnTile()
    refresh.renewLease('p1', [tileId, pipeline])
    await tick()
    expect(runner.calls).toHaveLength(2)
    for (const call of runner.calls) call.settle(ok({ items: [] }))
    for (let i = 0; i < 3; i++) await tick()
    expect(refresh.inFlightCount()).toBe(0)

    // Both fresh; both leased. Only the after_turn one runs again.
    expect(refresh.afterTurn('p1', 'folder:m1').sort()).toEqual([tileId, pipeline].sort())
    for (let i = 0; i < 5; i++) await tick()
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls[2].call.script).toBe('dashboards/pipeline/api/data.py')
  })

  it('re-reads a leased file-source tile after a turn without after_turn, but runs no refresh command unasked', async () => {
    writeAgentFile('dashboards/notes/component.json', JSON.stringify({ schema_version: 1, title: 'Notes', view: 'markdown', source: { file: 'app-data/notes.md' } }))
    writeAgentFile('app-data/notes.md', '# Before')
    const dashboardId = dashboards.list('p1')[0].id
    const notes = dashboards.addTile('p1', { dashboardId, agentId: 'folder:m1', component: 'notes' })
    const status = dashboards.addTile('p1', { dashboardId, agentId: 'folder:m1', component: 'status' })
    if (!notes.ok || !status.ok) throw new Error('add failed')
    await refresh.ensureFresh('p1', notes.tile.id, 'visible', { wait: true })
    await refresh.ensureFresh('p1', status.tile.id, 'visible', { wait: true })
    expect(runCommand).toHaveBeenCalledTimes(1)
    refresh.renewLease('p1', [notes.tile.id, status.tile.id])
    for (let i = 0; i < 5; i++) await tick()
    writeAgentFile('app-data/notes.md', '# After the turn')
    refresh.afterTurn('p1', 'folder:m1')
    // The file is read off disk asynchronously; under a loaded suite a fixed tick count is not always enough.
    await vi.waitFor(() => expect(refresh.tileResult('p1', notes.tile.id)).toMatchObject({ ok: true, result: { data: { markdown: '# After the turn' } } }))
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('leaves a Manual tile that has data alone after a turn, even when its component says after_turn', async () => {
    const pipeline = addAfterTurnTile()
    dashboards.updateTile('p1', { tileId: pipeline, refreshOverride: { manual: true } })
    refresh.renewLease('p1', [pipeline])
    await settleNext(ok({ items: [] }))
    const before = runner.calls.length
    expect(refresh.afterTurn('p1', 'folder:m1')).toEqual([pipeline])
    for (let i = 0; i < 5; i++) await tick()
    expect(runner.calls).toHaveLength(before)
  })

  it('runs nothing for a tile with no live lease, another profile’s lease, or another agent', async () => {
    const pipeline = addAfterTurnTile()
    expect(refresh.afterTurn('p1', 'folder:m1')).toEqual([])
    refresh.renewLease('p2', [pipeline])
    expect(refresh.afterTurn('p1', 'folder:m1')).toEqual([])
    refresh.dropLease('p2')
    refresh.renewLease('p1', [pipeline])
    await settleNext(ok({ items: [] }))
    const before = runner.calls.length
    expect(refresh.afterTurn('p1', 'folder:other')).toEqual([])
    clock += DASHBOARD_LEASE_TTL_MS + 1
    expect(refresh.afterTurn('p1', 'folder:m1')).toEqual([])
    await tick()
    expect(runner.calls).toHaveLength(before)
  })
})

/** Interval timers the test fires by hand. */
function manualTimers() {
  const live = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    live,
    timers: {
      setInterval: (fn: () => void, ms: number) => { const id = next++; live.set(id, { fn, ms }); return id },
      clearInterval: (handle: unknown) => { live.delete(handle as number) }
    },
    fireAll: () => { for (const timer of [...live.values()]) timer.fn() }
  }
}

function addComponentTile(name: string, spec: object, script = true): string {
  writeAgentFile(`dashboards/${name}/component.json`, JSON.stringify({ schema_version: 1, title: name, ...spec }))
  if (script) writeAgentFile(`dashboards/${name}/api/data.py`, 'print("{}")')
  const dashboardId = dashboards.list('p1')[0].id
  const added = dashboards.addTile('p1', { dashboardId, agentId: 'folder:m1', component: name })
  if (!added.ok) throw new Error(added.message)
  return added.tile.id
}

async function drain(): Promise<void> {
  for (let i = 0; i < 6; i++) await tick()
}

describe('the effective refresh rule (D4)', () => {
  it('lets a tile turn after_turn on for a component that does not ask for it, and off for one that does', async () => {
    refresh.renewLease('p1', [tileId])
    await settleNext(ok({ items: [] }))
    expect(refresh.afterTurn('p1', 'folder:m1')).toEqual([tileId])
    await drain()
    expect(runner.calls).toHaveLength(1)
    dashboards.updateTile('p1', { tileId, refreshOverride: { afterTurn: true } })
    refresh.afterTurn('p1', 'folder:m1')
    await drain()
    expect(runner.calls).toHaveLength(2)
  })

  it('reads the tile’s max age over the component’s', async () => {
    await refresh.ensureFresh('p1', tileId, 'visible')
    await settleNext(ok({ items: [] }))
    dashboards.updateTile('p1', { tileId, refreshOverride: { maxAge: '1m' } })
    clock += 61_000
    await refresh.ensureFresh('p1', tileId, 'visible')
    expect(runner.calls).toHaveLength(2)
  })
})

describe('params (D4)', () => {
  it('keeps the new params, recomputes with them whatever the age, and publishes the change', async () => {
    await refresh.ensureFresh('p1', tileId, 'visible')
    await settleNext(ok({ items: [] }))
    published.length = 0
    const saved = refresh.setParams('p1', { tileId, params: { month: '2026-09' } })
    await tick()
    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1].call.params).toEqual({ month: '2026-09' })
    expect(published[0]).toBe(tileId)
    runner.calls[1].settle(ok({ items: [{ id: 'sep' }] }))
    expect(await saved).toMatchObject({ ok: true, tile: { params: { month: '2026-09' } } })
    await drain()
    expect(refresh.tileResult('p1', tileId)).toMatchObject({ ok: true, result: { data: { items: [{ id: 'sep' }] } } })
  })

  it('runs nothing for a bad value or another profile’s tile', async () => {
    expect(await refresh.setParams('p1', { tileId, params: { month: '09/2026' } })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await refresh.setParams('p2', { tileId, params: { month: '2026-09' } })).toMatchObject({ ok: false, code: 'not_found' })
    await tick()
    expect(runner.calls).toHaveLength(0)
  })

  it('shares the tile’s per-minute endpoint budget with its page’s calls; above it nothing is kept or run, and a refused value costs nothing', async () => {
    const { DASHBOARD_CALLS_PER_MINUTE } = await import('../../../shared/dashboards')
    for (let i = 0; i < 3; i++) expect(await refresh.setParams('p1', { tileId, params: { month: '09/2026' } })).toMatchObject({ ok: false, code: 'invalid_input' })
    for (let i = 0; i < DASHBOARD_CALLS_PER_MINUTE - 1; i++) {
      void refresh.setParams('p1', { tileId, params: { month: '2026-09' } })
      clock += 1000
    }
    void refresh.call('p1', { target: { tileId }, endpoint: 'data' })
    await tick()
    const runs = runner.calls.length
    const refused = await refresh.setParams('p1', { tileId, params: { month: '2026-10' } })
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(refused.ok === false && refused.message).toBe(`This tile ran its endpoints more than ${DASHBOARD_CALLS_PER_MINUTE} times in a minute; wait a moment and try again.`)
    await tick()
    expect(runner.calls).toHaveLength(runs)
    expect(dashboards.resolveTile('p1', tileId)?.tile.params).toEqual({ month: '2026-09' })
    // The oldest change leaves the window: one more is let through.
    clock += 31_000
    const later = refresh.setParams('p1', { tileId, params: { month: '2026-10' } })
    await tick()
    expect(runner.calls).toHaveLength(runs + 1)
    for (const c of runner.calls) c.settle(ok({ items: [] }))
    expect(await later).toMatchObject({ ok: true, tile: { params: { month: '2026-10' } } })
    await drain()
  })

  it('accepts only the renderer’s reasons through ensureFresh’s own check, and every reason main uses', async () => {
    expect(await refresh.ensureFresh('p1', tileId, 'whenever')).toMatchObject({ ok: false, code: 'invalid_input' })
    for (const reason of ['interval', 'launch', 'params', 'schedule'] as const) expect((await refresh.ensureFresh('p1', tileId, reason)).ok).toBe(true)
  })
})

describe('tools/call (D4)', () => {
  beforeEach(() => {
    writeAgentFile('dashboards/deals/component.json', JSON.stringify({
      schema_version: 1, title: 'Deals', view: 'html', source: { endpoint: 'data' },
      endpoints: { data: { script: 'api/data.py' }, history: { script: 'api/history.py', timeout_s: 45 } },
      params: { month: { type: 'month', default: 'current' }, stage: { type: 'enum', values: ['lead', 'won'] } }
    }))
    writeAgentFile('dashboards/deals/index.html', '<html><body></body></html>')
    writeAgentFile('dashboards/deals/api/history.py', 'print("{}")')
  })

  it('runs one of the component’s own endpoints once, with its timeout, never cached', async () => {
    dashboards.setParams('p1', { tileId, params: { stage: 'won' } })
    const answer = refresh.call('p1', { target: { tileId }, endpoint: 'history', params: { deal_id: 'd-7' } })
    await tick()
    expect(runner.calls[0].call).toMatchObject({ script: 'dashboards/deals/api/history.py', timeoutS: 45, key: `call:tile:${tileId}:history` })
    // The stdin convention: defaults, then the tile's values, then the call's arguments.
    const at = new Date(clock)
    expect(runner.calls[0].call.params).toEqual({ month: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`, stage: 'won', deal_id: 'd-7' })
    runner.calls[0].settle(ok({ events: [1, 2] }))
    expect(await answer).toEqual({ ok: true, value: { events: [1, 2] } })
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM dashboard_tile_results').get()).toEqual({ n: 0 })
  })

  it('refuses an endpoint the component does not declare, a bad declared param, and another profile’s tile, running nothing', async () => {
    expect(await refresh.call('p1', { target: { tileId }, endpoint: 'secrets' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await refresh.call('p1', { target: { tileId }, endpoint: '__proto__' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await refresh.call('p1', { target: { tileId }, endpoint: 'history', params: { stage: 'lost' } })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await refresh.call('p2', { target: { tileId }, endpoint: 'history' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await refresh.call('p1', { endpoint: 'history' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(runner.calls).toHaveLength(0)
  })

  it('answers a failure as data with the runner’s (already redacted) sentence', async () => {
    const answer = refresh.call('p1', { target: { tileId }, endpoint: 'history' })
    await settleNext({ ok: false, code: 'failed', message: 'The endpoint exited with code 1: boom', durationMs: 2 })
    expect(await answer).toEqual({ ok: false, code: 'call_failed', message: 'The endpoint exited with code 1: boom' })
  })

  it('lets the newest call per (target, endpoint) win, by the runner’s key', async () => {
    const first = refresh.call('p1', { target: { tileId }, endpoint: 'history' })
    const second = refresh.call('p1', { target: { tileId }, endpoint: 'history' })
    await tick()
    expect(runner.calls.map((c) => c.call.key)).toEqual([`call:tile:${tileId}:history`, `call:tile:${tileId}:history`])
    runner.calls[0].settle({ ok: false, code: 'superseded', message: 'superseded', durationMs: 0 })
    runner.calls[1].settle(ok(1))
    expect(await first).toMatchObject({ ok: false, code: 'call_failed', message: 'A newer call to this endpoint replaced this one.' })
    expect(await second).toEqual({ ok: true, value: 1 })
  })

  it('takes at most DASHBOARD_CALLS_PER_MINUTE per tile in a sliding minute, the rest refused with a sentence', async () => {
    const { DASHBOARD_CALLS_PER_MINUTE } = await import('../../../shared/dashboards')
    const answers: Array<Promise<unknown>> = []
    for (let i = 0; i < DASHBOARD_CALLS_PER_MINUTE; i++) {
      answers.push(refresh.call('p1', { target: { tileId }, endpoint: 'history' }))
      clock += 1000
    }
    const refused = await refresh.call('p1', { target: { tileId }, endpoint: 'data' })
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(refused.ok === false && refused.message).toMatch(/more than 30 times in a minute/)
    // Another target has its own window.
    const preview = refresh.call('p1', { target: { agentId: 'folder:m1', component: 'deals' }, endpoint: 'history' })
    await tick()
    expect(runner.calls).toHaveLength(DASHBOARD_CALLS_PER_MINUTE + 1)
    expect(runner.calls[DASHBOARD_CALLS_PER_MINUTE].call.key).toBe('call:preview:p1:folder:m1::deals:history')
    // The oldest call leaves the window: one more is let through.
    clock += 31_000
    const later = refresh.call('p1', { target: { tileId }, endpoint: 'history' })
    await tick()
    expect(runner.calls).toHaveLength(DASHBOARD_CALLS_PER_MINUTE + 2)
    for (const c of runner.calls) c.settle(ok(null))
    await Promise.all([...answers, preview, later])
  })

  it('spawns nothing while a required credential is missing', async () => {
    writeAgentFile('cinna-agent.json', JSON.stringify({ id: 'm1', credentials: [{ name: 'gmail' }] }))
    writeAgentFile('dashboards/deals/component.json', JSON.stringify({
      schema_version: 1, title: 'Deals', view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, requires_credentials: ['gmail']
    }))
    agents[0].credentialSlots = [{ name: 'gmail', ready: false }]
    const answer = await refresh.call('p1', { target: { tileId }, endpoint: 'data' })
    expect(answer).toMatchObject({ ok: false, code: 'needs_credentials' })
    expect(answer.ok === false && answer.message).toMatch(/“gmail” credential/)
    expect(runner.calls).toHaveLength(0)
  })
})

describe('while open (D4, reason interval)', () => {
  let timers: ReturnType<typeof manualTimers>
  beforeEach(() => {
    timers = manualTimers()
    refresh = createDashboardRefreshService({ dashboards, runner: runner.runner, runCommand, publish: (id) => published.push(id), now: () => clock, timers: timers.timers })
  })

  it('times a leased tile with an interval, recomputes on each tick, and stops when the lease lapses', async () => {
    const live = addComponentTile('live', { view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, refresh: { max_age: '1h', while_open_every: '2m' } })
    refresh.renewLease('p1', [live, tileId])
    await settleNext(ok({ items: [] }))
    runner.calls[0].settle(ok({ items: [] }))
    await drain()
    expect(timers.live.size).toBe(1)
    expect([...timers.live.values()][0].ms).toBe(120_000)
    const before = runner.calls.length
    clock += 120_000
    // The renderer renews every 20 s; a renewal alone does not run a fresh tile.
    refresh.renewLease('p1', [live, tileId])
    await drain()
    expect(runner.calls).toHaveLength(before)
    timers.fireAll()
    await drain()
    expect(runner.calls).toHaveLength(before + 1)
    expect(runner.calls[before].call.script).toBe('dashboards/live/api/data.py')
    runner.calls[before].settle(ok({ items: [] }))
    await drain()
    // The lease lapses: the next tick stops the timer and runs nothing.
    clock += DASHBOARD_LEASE_TTL_MS + 1
    timers.fireAll()
    await drain()
    expect(timers.live.size).toBe(0)
    expect(runner.calls).toHaveLength(before + 1)
  })

  it('follows the tile’s override, and never runs without a lease: dropped, profile closed', async () => {
    const live = addComponentTile('live', { view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, refresh: { while_open_every: '2m' } })
    // The deals tile asks for none; its override turns one on.
    dashboards.updateTile('p1', { tileId, refreshOverride: { whileOpenEvery: '5m' } })
    dashboards.updateTile('p1', { tileId: live, refreshOverride: { whileOpenEvery: null } })
    refresh.renewLease('p1', [live, tileId])
    await drain()
    expect([...timers.live.values()].map((t) => t.ms)).toEqual([300_000])
    expect(refresh.timerCount()).toBe(1)
    refresh.dropLease('p1', [tileId])
    expect(refresh.timerCount()).toBe(0)
    refresh.renewLease('p1', [tileId])
    await drain()
    expect(refresh.timerCount()).toBe(1)
    void refresh.cancelAll()
    expect(timers.live.size).toBe(0)
    expect(refresh.timerCount()).toBe(0)
  })

  it('skips a tick right after another run, and leaves a Manual tile with data alone', async () => {
    dashboards.updateTile('p1', { tileId, refreshOverride: { whileOpenEvery: '2m' } })
    refresh.renewLease('p1', [tileId])
    await settleNext(ok({ items: [] }))
    clock += 30_000
    timers.fireAll()
    await drain()
    expect(runner.calls).toHaveLength(1)
    dashboards.updateTile('p1', { tileId, refreshOverride: { whileOpenEvery: '2m', manual: true } })
    clock += 120_000
    timers.fireAll()
    await drain()
    expect(runner.calls).toHaveLength(1)
  })
})

describe('launch warm-up (D4, reason launch)', () => {
  function warmTiles(): { warm: string; second: string } {
    const warm = addComponentTile('warm', { view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, refresh: { on_app_start: true } })
    const second = addComponentTile('second', { view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, refresh: { on_app_start: true, max_age: '1h' } })
    return { warm, second }
  }

  it('runs on_app_start tiles one at a time, skipping one whose cache is younger than its max age', async () => {
    const { warm, second } = warmTiles()
    refresh = createDashboardRefreshService({ dashboards, runner: runner.runner, runCommand, publish: () => {}, now: () => clock, warmupDisabled: () => false })
    // `second` has a fresh cache; the deals tile does not ask.
    holder.current!.raw.prepare('INSERT INTO dashboard_tile_results (tile_id, params_hash, result_json, fetched_at, error, duration_ms, too_large, updated_at) VALUES (?, ?, ?, ?, NULL, 1, 0, ?)')
      .run(second, (await import('./dashboardRefreshService')).paramsHash({}), '{}', clock - 60_000, clock - 60_000)
    const done = refresh.warmUp('p1')
    await drain()
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].call.script).toBe('dashboards/warm/api/data.py')
    runner.calls[0].settle(ok({ items: [] }))
    expect(await done).toEqual([warm])
    expect(runner.calls).toHaveLength(1)
  })

  it('takes the tile’s onAppStart over the component’s, one after another', async () => {
    const { warm } = warmTiles()
    dashboards.updateTile('p1', { tileId: warm, refreshOverride: { onAppStart: false } })
    dashboards.updateTile('p1', { tileId, refreshOverride: { onAppStart: true } })
    refresh = createDashboardRefreshService({ dashboards, runner: runner.runner, runCommand, publish: () => {}, now: () => clock, warmupDisabled: () => false })
    const done = refresh.warmUp('p1')
    await drain()
    expect(runner.calls.map((c) => c.call.script)).toEqual(['dashboards/deals/api/data.py'])
    runner.calls[0].settle(ok({ items: [] }))
    await drain()
    // Then `second`, only once the first finished.
    expect(runner.calls.map((c) => c.call.script)).toEqual(['dashboards/deals/api/data.py', 'dashboards/second/api/data.py'])
    runner.calls[1].settle(ok({ items: [] }))
    expect((await done).sort()).toEqual([tileId, (dashboards.placements('p1', 'folder:m1').find((p) => p.component === 'second'))!.tileId].sort())
  })

  it('is off with CINNA_DASHBOARD_WARMUP=off, and a profile close stops it between tiles', async () => {
    warmTiles()
    const before = process.env.CINNA_DASHBOARD_WARMUP
    process.env.CINNA_DASHBOARD_WARMUP = 'off'
    try {
      expect(await refresh.warmUp('p1')).toEqual([])
      expect(runner.calls).toHaveLength(0)
    } finally {
      if (before === undefined) delete process.env.CINNA_DASHBOARD_WARMUP
      else process.env.CINNA_DASHBOARD_WARMUP = before
    }
    refresh = createDashboardRefreshService({ dashboards, runner: runner.runner, runCommand, publish: () => {}, now: () => clock, warmupDisabled: () => false })
    const done = refresh.warmUp('p1')
    await drain()
    expect(runner.calls).toHaveLength(1)
    await refresh.cancelAll()
    expect(runner.calls[0].call.signal?.aborted).toBe(true)
    expect(await done).toHaveLength(1)
    await drain()
    expect(runner.calls).toHaveLength(1)
  })
})

describe('schedule-fed tiles (D4, reason schedule)', () => {
  function fedTiles() {
    writeAgentFile('cinna-agent.json', JSON.stringify({ id: 'm1', schedules: [{ name: 'nightly' }, { name: 'hourly' }] }))
    writeAgentFile('app-data/inbox.md', '# Before')
    const inbox = addComponentTile('inbox', { view: 'markdown', source: { file: 'app-data/inbox.md' }, refresh: { schedule: 'nightly', command: '/run:update-status' } }, false)
    const ranked = addComponentTile('ranked', { view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, refresh: { schedule: 'nightly' } })
    const other = addComponentTile('other', { view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, refresh: { schedule: 'hourly' } })
    return { inbox, ranked, other }
  }

  it('runs the source of every tile the schedule feeds once, lease or not; a file is re-read without its command', async () => {
    const { inbox, ranked } = fedTiles()
    writeAgentFile('app-data/inbox.md', '# Ranked by the schedule')
    expect(refresh.scheduleRan('p1', 'folder:m1', 'nightly').sort()).toEqual([inbox, ranked].sort())
    await drain()
    expect(runner.calls.map((c) => c.call.script)).toEqual(['dashboards/ranked/api/data.py'])
    expect(runCommand).not.toHaveBeenCalled()
    // The file is read off disk asynchronously; under a loaded suite six ticks are not always enough.
    await vi.waitFor(() => expect(refresh.tileResult('p1', inbox)).toMatchObject({ ok: true, result: { data: { markdown: '# Ranked by the schedule' } } }))
    // Another profile's dashboards are not this one's.
    expect(refresh.scheduleRan('p2', 'folder:m1', 'nightly')).toEqual([])
  })

  it('Refresh on a schedule-fed tile re-reads the same way: no command', async () => {
    const { inbox } = fedTiles()
    await refresh.ensureFresh('p1', inbox, 'manual', { wait: true })
    expect(runCommand).not.toHaveBeenCalled()
    expect(refresh.tileResult('p1', inbox)).toMatchObject({ ok: true, result: { data: { markdown: '# Before' } } })
  })

  it('leaves a Manual tile with data alone', async () => {
    const { ranked } = fedTiles()
    await refresh.ensureFresh('p1', ranked, 'visible')
    await settleNext(ok({ items: [] }))
    dashboards.updateTile('p1', { tileId: ranked, refreshOverride: { manual: true } })
    refresh.scheduleRan('p1', 'folder:m1', 'nightly')
    await drain()
    expect(runner.calls).toHaveLength(1)
  })
})

describe('Manual wins over every automatic reason (D4)', () => {
  it('a Manual tile with data recomputes on no after_turn, interval, launch or schedule; Refresh and params still do', async () => {
    writeAgentFile('cinna-agent.json', JSON.stringify({ id: 'm1', schedules: [{ name: 'nightly' }] }))
    const all = addComponentTile('all', {
      view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } },
      refresh: { max_age: '1m', after_turn: true, on_app_start: true, while_open_every: '1m', schedule: 'nightly' }
    })
    refresh = createDashboardRefreshService({ dashboards, runner: runner.runner, runCommand, publish: () => {}, now: () => clock, warmupDisabled: () => false, timers: manualTimers().timers })
    await refresh.ensureFresh('p1', all, 'manual')
    await settleNext(ok({ items: [] }))
    dashboards.updateTile('p1', { tileId: all, refreshOverride: { manual: true } })
    clock += 10 * 60_000
    refresh.renewLease('p1', [all])
    for (const reason of ['after_turn', 'interval', 'launch', 'schedule', 'visible'] as const) await refresh.ensureFresh('p1', all, reason)
    refresh.afterTurn('p1', 'folder:m1')
    refresh.scheduleRan('p1', 'folder:m1', 'nightly')
    expect(await refresh.warmUp('p1')).toEqual([])
    await drain()
    expect(runner.calls).toHaveLength(1)
    await refresh.ensureFresh('p1', all, 'manual')
    await settleNext(ok({ items: [] }))
    expect(runner.calls).toHaveLength(2)
    void refresh.setParams('p1', { tileId: all, params: {} })
    await drain()
    expect(runner.calls).toHaveLength(3)
  })
})

describe('preview params (D4)', () => {
  it('counts previews with params against the preview target’s budget, not those without', async () => {
    const { DASHBOARD_CALLS_PER_MINUTE } = await import('../../../shared/dashboards')
    const answers: Array<Promise<unknown>> = []
    for (let i = 0; i < DASHBOARD_CALLS_PER_MINUTE; i++) answers.push(refresh.preview('p1', 'folder:m1', 'deals', null, { month: '2026-02' }))
    await tick()
    expect(runner.calls).toHaveLength(DASHBOARD_CALLS_PER_MINUTE)
    const refused = await refresh.preview('p1', 'folder:m1', 'deals', null, { month: '2026-03' })
    expect(refused).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(refused.ok === false && refused.message).toMatch(/^This preview ran its endpoints more than 30 times/)
    // The page's own calls share that budget.
    expect(await refresh.call('p1', { target: { agentId: 'folder:m1', component: 'deals' }, endpoint: 'data' })).toMatchObject({ ok: false, code: 'rate_limited' })
    // Opening the preview is the user's click: never refused.
    answers.push(refresh.preview('p1', 'folder:m1', 'deals'))
    // …nor is the `{}` a preview sends when it opens.
    answers.push(refresh.preview('p1', 'folder:m1', 'deals', null, {}))
    await tick()
    expect(runner.calls).toHaveLength(DASHBOARD_CALLS_PER_MINUTE + 2)
    for (const c of runner.calls) c.settle(ok({ items: [] }))
    await Promise.all(answers)
  })

  it('runs the preview’s source with params checked as a tile’s, and refuses a bad one before running', async () => {
    const preview = refresh.preview('p1', 'folder:m1', 'deals', null, { month: '2026-02', other: 1 })
    await tick()
    expect(runner.calls[0].call.params).toEqual({ month: '2026-02' })
    runner.calls[0].settle(ok({ items: [] }))
    expect(await preview).toMatchObject({ ok: true })
    expect(await refresh.preview('p1', 'folder:m1', 'deals', null, { month: 'Feb' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(runner.calls).toHaveLength(1)
  })
})

describe('Dashboards turned off (Settings → Features → Capabilities)', () => {
  let on = false
  let timers: ReturnType<typeof manualTimers>
  beforeEach(() => {
    on = false
    timers = manualTimers()
    refresh = createDashboardRefreshService({ dashboards, runner: runner.runner, runCommand, publish: () => {}, now: () => clock, warmupDisabled: () => false, timers: timers.timers, enabled: () => on })
  })

  it('warms nothing up at launch', async () => {
    addComponentTile('warm', { view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, refresh: { on_app_start: true } })
    expect(await refresh.warmUp('p1')).toEqual([])
    await drain()
    expect(runner.calls).toHaveLength(0)
  })

  it('arms no interval timer, stops a running one at its next tick, and arms again at the renewal after it is turned on', async () => {
    dashboards.updateTile('p1', { tileId, refreshOverride: { whileOpenEvery: '2m' } })
    refresh.renewLease('p1', [tileId])
    await settleNext(ok({ items: [] }))
    expect(timers.live.size).toBe(0)
    // Turned on: the next renewal (the renderer's 20 s) arms it.
    on = true
    refresh.renewLease('p1', [tileId])
    await drain()
    expect(timers.live.size).toBe(1)
    // Turned off while it runs: the next tick — the lease still live — stops it and runs nothing.
    on = false
    const before = runner.calls.length
    expect(refresh.isLeased(tileId, 'p1')).toBe(true)
    timers.fireAll()
    await drain()
    expect(timers.live.size).toBe(0)
    expect(runner.calls).toHaveLength(before)
  })

  it('runs no schedule-fed tile', async () => {
    writeAgentFile('cinna-agent.json', JSON.stringify({ id: 'm1', schedules: [{ name: 'nightly' }] }))
    addComponentTile('ranked', { view: 'list', source: { endpoint: 'data' }, endpoints: { data: { script: 'api/data.py' } }, refresh: { schedule: 'nightly' } })
    expect(refresh.scheduleRan('p1', 'folder:m1', 'nightly')).toEqual([])
    await drain()
    expect(runner.calls).toHaveLength(0)
  })
})
