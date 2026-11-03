import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
let runCommand: ReturnType<typeof vi.fn>
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
    for (let i = 0; i < 10; i++) await tick()
    expect(refresh.tileResult('p1', notes.tile.id)).toMatchObject({ ok: true, result: { data: { markdown: '# After the turn' } } })
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
