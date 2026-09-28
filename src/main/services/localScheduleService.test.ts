import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { AgentRow } from '../db/agents'
import type { AgentDriver } from '../agents/drivers/driver'
import type { ScheduleCommandOutcome } from '../../shared/localSchedules'

const state = vi.hoisted(() => ({ database: null as TestDatabase | null, agents: [] as AgentRow[], get: vi.fn(), resolveCommand: vi.fn(), runScheduled: vi.fn() }))
const driverRun = vi.hoisted(() => vi.fn<AgentDriver['run']>())
vi.mock('../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__', getAgentLookupScope: () => ['__default__'] }))
vi.mock('../mcp/manager', () => ({ mcpManager: { getConnection: () => null } }))
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty() {} } }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('./taskFileService', () => ({ taskFileService: { exportHandoff() {}, removeHandoff() {} } }))
vi.mock('./chatTitleService', () => ({ chatTitleService: { autoGenerateForFirstMessage: async () => {} }, ChatTitleError: class extends Error {} }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: { get: state.get } }))
vi.mock('./agentService', () => ({ agentService: {
  findAgent: (_settings: string, _user: string, id: string) => { const row = state.agents.find((agent) => agent.id === id); return row ? { row, userId: '__default__' } : null },
  listMerged: () => state.agents
} }))
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ run: driverRun, capabilities: () => ({ commands: { source: 'none' } }) }) }))
vi.mock('./localAgents/commandService', () => ({
  commandService: { resolve: state.resolveCommand, runScheduled: state.runScheduled },
  resolveCommandRunner: (_cap: unknown, _wire: string, _user: string, _agent: string, run: unknown) => run
}))
const { localScheduleService } = await import('./localScheduleService')
const { localScheduleRepo } = await import('../db/localSchedules')
const { scriptRuntimeService } = await import('./scriptRuntimeService')
const { scriptRuntimeRepo } = await import('../db/scriptRuntimes')
const { taskRepo } = await import('../db/tasks')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { jobService } = await import('./jobService')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { userRepo } = await import('../db/users')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { activeRunsByChat } = await import('./runExecutionState')
const USER = '__default__'
const MANIFEST = 'aa270900-138e-4a59-b2a0-ea25b7bb457e'
const AGENT = `folder:${MANIFEST}`
const scope = { profileUserId: USER, settingsUserId: USER }
const BASE = Date.parse('2026-09-12T09:00:00Z')
let definition: { name: string; cron_string: string; timezone: string | null; schedule_type: string; prompt: string; command?: string; enabled?: boolean }

beforeEach(() => {
  state.database = createTestDatabase()
  definition = { name: 'Daily check', cron_string: '* * * * *', timezone: 'UTC', schedule_type: 'static_prompt', prompt: 'Read literal {{goal}} and {{unknown.text}}.' }
  state.agents = [{ id: AGENT, name: 'Verifier', driver: 'acp', source: 'folder', enabled: true, userId: USER } as AgentRow]
  state.database.raw.prepare(`INSERT INTO agents (id,user_id,name,protocol,enabled,source,driver,created_at) VALUES (?,?,'Verifier','local-folder',1,'folder','acp',1)`).run(AGENT, USER)
  state.get.mockReset().mockImplementation(() => ({ id: AGENT, name: 'Verifier', kind: 'kit', enabled: true, readiness: 'ok', manifest: { id: MANIFEST, schedules: [structuredClone(definition)] } }))
  driverRun.mockReset().mockImplementation(async () => ({ text: 'Checked', parts: [], notices: [], taskState: 'completed' }))
  state.resolveCommand.mockReset().mockImplementation((_user, _agent, command) => ({ localCommand: command, revision: `reviewed:${command}` }))
  state.runScheduled.mockReset()
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const entry of taskRunnersByChat.values()) { try { entry.cancel() } catch { /* terminal */ } }
  await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  taskRunnersByChat.clear()
  state.database?.close(); state.database = null
})
function review() {
  const item = localScheduleService.list(scope, AGENT)[0]
  return { profileUserId: USER, agentId: AGENT, name: item.name, revision: item.revision!, timezone: item.timezone }
}
function enable(now = BASE) { localScheduleService.enable(scope, review(), now); return localScheduleRepo.list(USER)[0] }
function check(now = BASE + 60000) { localScheduleService.check(scope, () => true, () => now) }
async function settled(bindingId: string) {
  await vi.waitFor(() => expect(localScheduleService.list(scope, AGENT)[0].binding?.last?.status).toBe('completed'))
  return localScheduleRepo.latest(USER, bindingId)!
}
function commandOutcome(patch: Partial<ScheduleCommandOutcome> = {}): ScheduleCommandOutcome {
  return { stdout: 'OK', stderr: '', exitCode: 0, startedAt: BASE + 60000, finishedAt: BASE + 61000,
    timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false, ...patch }
}

describe('local schedule admission and persistence', () => {
  it.each([
    ['five missed mornings', '2026-09-14T07:00:00Z', '2026-09-21T11:00:00Z', '2026-09-14T08:00:00Z', '2026-09-22T08:00:00Z'],
    ['weekend recovery', '2026-09-18T07:00:00Z', '2026-09-19T11:00:00Z', '2026-09-18T08:00:00Z', '2026-09-21T08:00:00Z'],
    ['recovery exactly on a matching minute', '2026-09-14T07:00:00Z', '2026-09-21T08:00:00Z', '2026-09-14T08:00:00Z', '2026-09-22T08:00:00Z']
  ])('collapses %s into one durable occurrence using its original due civil key', async (_label, enabled, observed, scheduled, next) => {
    definition.cron_string = '0 8 * * 1-5'
    const binding = enable(Date.parse(enabled))
    expect(binding.nextDueAt).toBe(Date.parse(scheduled))
    check(Date.parse(observed)); check(Date.parse(observed)); check(Date.parse(observed) + 1)
    const receipt = await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    expect(receipt).toMatchObject({ scheduledFor: Date.parse(scheduled), observedAt: Date.parse(observed), coveredThrough: Date.parse(observed),
      civilKey: `UTC|${scheduled.slice(0, 16)}`, triggerKind: 'catch_up' })
    expect(localScheduleRepo.get(USER, binding.id)).toMatchObject({ nextDueAt: Date.parse(next), lastAttemptAt: Date.parse(observed), cursorVersion: binding.cursorVersion + 1 })
  })

  it('launches an admitted run even when a minute boundary passes between claim and launch', async () => {
    const binding = enable()
    let clock = BASE + 60000 + 30000
    const prepareJob = scriptRuntimeService.prepareJob.bind(scriptRuntimeService)
    vi.spyOn(scriptRuntimeService, 'prepareJob').mockImplementation((...args) => { clock += 60000; return prepareJob(...args) })
    localScheduleService.check(scope, () => true, () => clock)
    const receipt = await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(receipt).toMatchObject({ status: 'dispatched', reason: null })
  })

  it('catches up hourly work once and resumes at the next selected hour', async () => {
    definition.cron_string = '0 9-18 * * 1-5'
    const binding = enable(Date.parse('2026-09-21T08:00:00Z'))
    check(Date.parse('2026-09-21T13:40:00Z'))
    await settled(binding.id)
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(Date.parse('2026-09-21T14:00:00Z'))
    check(Date.parse('2026-09-21T14:00:00Z'))
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(2)
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ scheduledFor: Date.parse('2026-09-21T14:00:00Z'), triggerKind: 'scheduled' })
  })

  it('retains the reconciled completion time while observing a minute before the next due time', async () => {
    definition.cron_string = '0 8 * * 1-5'
    const binding = enable(Date.parse('2026-09-21T07:00:00Z'))
    check(Date.parse('2026-09-21T08:00:00Z'))
    await settled(binding.id)
    check(Date.parse('2026-09-21T08:01:00Z'))
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    expect(receipt.finishedAt).toEqual(expect.any(Number))
    expect(localScheduleRepo.get(USER, binding.id)?.lastCompletedAt).toBe(receipt.finishedAt)
  })

  it('never catches up work before creation or during a disabled period', async () => {
    definition.cron_string = '0 8 * * 1-5'
    const binding = enable(Date.parse('2026-09-21T11:00:00Z'))
    check(Date.parse('2026-09-21T11:00:00Z'))
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    localScheduleService.disable(scope, binding.id)
    check(Date.parse('2026-09-29T11:00:00Z'))
    localScheduleService.enable(scope, review(), Date.parse('2026-09-29T11:00:00Z'))
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(Date.parse('2026-09-30T08:00:00Z'))
    check(Date.parse('2026-09-29T12:00:00Z'))
    expect(driverRun).not.toHaveBeenCalled()
    check(Date.parse('2026-09-30T08:00:00Z'))
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })

  it('consumes a failed catch-up admission and allows the next normal occurrence', async () => {
    definition.cron_string = '0 8 * * 1-5'
    const binding = enable(Date.parse('2026-09-14T07:00:00Z'))
    const prepare = vi.spyOn(scriptRuntimeService, 'prepareJob').mockImplementationOnce(() => { throw new Error('Cannot prepare this task') })
    const observed = Date.parse('2026-09-21T11:00:00Z')
    check(observed); check(observed + 60000)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ status: 'failed', triggerKind: 'catch_up', reason: 'Cannot prepare this task' })
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(Date.parse('2026-09-22T08:00:00Z'))
    check(Date.parse('2026-09-22T08:00:00Z'))
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(2)
  })

  it('claims once when another check is reentered during task preparation', async () => {
    const binding = enable()
    const prepare = scriptRuntimeService.prepareJob
    let reentered = false
    vi.spyOn(scriptRuntimeService, 'prepareJob').mockImplementation((...args) => {
      if (!reentered) { reentered = true; check() }
      return prepare(...args)
    })
    check()
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    expect(localScheduleRepo.get(USER, binding.id)?.cursorVersion).toBe(binding.cursorVersion + 1)
    expect(localScheduleRepo.claim(binding, BASE + 180000, BASE + 120000)).toBe(false)
  })

  it('does not replay consumed work when the system clock rolls backward', async () => {
    const binding = enable()
    check(BASE + 5 * 86400000)
    await settled(binding.id)
    const future = localScheduleRepo.get(USER, binding.id)!
    for (const now of [BASE + 60000, BASE + 3 * 86400000, BASE + 5 * 86400000 - 60000]) check(now)
    expect(localScheduleRepo.get(USER, binding.id)).toMatchObject({ nextDueAt: future.nextDueAt, cursorVersion: future.cursorVersion,
      watermark: future.watermark, lastAttemptAt: future.lastAttemptAt })
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })

  it('admits one catch-up for all missed times beside an interrupted earlier task instead of skipping', async () => {
    const binding = enable()
    const prior = scriptRuntimeService.prepareJob(scope, jobsRepo.getById(USER, binding.jobId)!)
    scriptRuntimeService.interruptPrepared(USER, prior.taskId, 'Review prior work')
    const observed = BASE + 5 * 86400000
    check(observed); check(observed)
    const receipt = await settled(binding.id)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    expect(receipt).toMatchObject({ scheduledFor: BASE + 60000, coveredThrough: observed, triggerKind: 'catch_up' })
    expect(receipt.taskId).not.toBe(prior.taskId)
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(observed + 60000)
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(scriptRuntimeRepo.get(USER, prior.taskId)?.state).toBe('interrupted')
  })

  it('keeps opt-in across a transient folder failure and makes listing read-only', async () => {
    const binding = enable()
    const healthy = state.get.getMockImplementation()!
    state.get.mockImplementation(() => { throw new Error('EBUSY: manifest is being saved') })
    expect(localScheduleService.list(scope, AGENT)[0].binding?.reason).toContain('EBUSY')
    expect(localScheduleRepo.get(USER, binding.id)).toEqual(binding)
    check()
    expect(localScheduleRepo.get(USER, binding.id)).toEqual(binding)
    expect(driverRun).not.toHaveBeenCalled()
    state.get.mockImplementation(healthy)
    check(BASE + 120000)
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })

  it('enables and runs a schedule on an agent whose credentials are missing, but not on an invalid one', async () => {
    const healthy = state.get.getMockImplementation()!
    const withReadiness = (readiness: string) => () => ({ ...(healthy() as object), readiness, readinessReason: `Folder is ${readiness}.` })
    state.get.mockImplementation(withReadiness('invalid'))
    expect(localScheduleService.list(scope, AGENT)[0].problem).toBe('Folder is invalid.')
    state.get.mockImplementation(withReadiness('credentials_needed'))
    expect(localScheduleService.list(scope, AGENT)[0].problem).toBeNull()
    const binding = enable()
    expect(localScheduleService.list(scope, AGENT)[0].binding).toMatchObject({ enabled: true, reason: null })
    check()
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })

  it('does not let a soft-deleted blocked task reserve every later occurrence', async () => {
    const binding = enable()
    const prepared = scriptRuntimeService.prepareJob(scope, jobsRepo.getById(USER, binding.jobId)!)
    taskRepo.update(USER, prepared.taskId, { status: 'blocked' })
    taskRepo.softDelete(USER, prepared.taskId)
    check()
    await settled(binding.id)
  })

  it('lists without opt-in, freezes the literal prompt, skips initial minute and dispatches once after commit', async () => {
    expect(review().revision).toBeTruthy()
    check()
    expect(jobsRepo.list(USER)).toEqual([])
    expect(taskRepo.list(USER)).toEqual([])
    const binding = enable()
    check(BASE)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    check(); check()
    const receipt = await settled(binding.id)
    expect(receipt.definition.prompt).toBe(definition.prompt)
    expect(jobRunsRepo.getById(USER, receipt.runId!)).toMatchObject({ taskId: receipt.taskId, status: 'succeeded' })
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(driverRun.mock.calls[0][2].wireContent).toContain(definition.prompt)
    expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.steps.run.prompt).toBe(definition.prompt)
    expect(taskRepo.list(USER)).toHaveLength(2)
  })
  it('records one failed observation after rolling back all prepared execution rows', () => {
    const binding = enable()
    const insert = localScheduleRepo.insertOccurrence
    let failed = false
    vi.spyOn(localScheduleRepo, 'insertOccurrence').mockImplementation((row) => {
      if (!failed && row.status === 'prepared') { failed = true; throw new Error('Receipt write refused') }
      insert(row)
    })
    check(); check()
    expect(localScheduleRepo.occurrences(USER, binding.id)).toMatchObject([{ status: 'failed', taskId: null, reason: 'Receipt write refused' }])
    expect(jobRunsRepo.listByJob(USER, binding.jobId)).toEqual([])
    expect(taskRepo.list(USER)).toEqual([])
    expect(scriptRuntimeRepo.list(USER)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
    expect(taskRunnersByChat.size).toBe(0)
  })
  it('turns a committed but unlaunched occurrence into explicit interrupted recovery', async () => {
    const binding = enable()
    const prepare = scriptRuntimeService.prepareJob
    vi.spyOn(scriptRuntimeService, 'prepareJob').mockImplementation((captured, job) => ({ ...prepare(captured, job), launch() { throw new Error('Profile switched before launch') } }))
    check(); check()
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    expect(receipt).toMatchObject({ status: 'interrupted', reason: 'Profile switched before launch' })
    expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.state).toBe('interrupted')
    scriptRuntimeService.recover()
    vi.mocked(scriptRuntimeService.prepareJob).mockRestore()
    check(BASE + 120000)
    // The interrupted occurrence waits for review; the next one still runs.
    const next = await settled(binding.id)
    expect(next.id).not.toBe(receipt.id)
    expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.status).toBe('interrupted')
    expect(driverRun).toHaveBeenCalledTimes(1)
  })
  it('admits an occurrence beside a manually prepared interrupted run of the generated Job', async () => {
    const binding = enable()
    const prior = scriptRuntimeService.prepareJob(scope, jobsRepo.getById(USER, binding.jobId)!)
    scriptRuntimeService.interruptPrepared(USER, prior.taskId, 'Review prior work')
    check()
    const receipt = await settled(binding.id)
    expect(receipt.taskId).not.toBe(prior.taskId)
    expect(jobRunsRepo.listByJob(USER, binding.jobId)).toHaveLength(2)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })
  it('deleting a waiting scheduled run cancels its tasks and gates and allows a later occurrence', async () => {
    driverRun.mockImplementationOnce(async (_owner, _row, input) => {
      input.onEvent?.({ type: 'needs_input', requestId: 'publish', resume: 'next_message', request: {
        kind: 'question', questions: [{ question: 'Publish?', multiSelect: false, options: [] }]
      } })
      return { text: 'Waiting for a choice', parts: [], notices: [], taskState: 'input-required' }
    })
    const binding = enable()
    check()
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(taskInputRequestRepo.listOpen(USER)).toHaveLength(1)
    expect(jobService.deleteRun(USER, receipt.runId!)).toMatchObject({ chatDeleted: true })
    expect(taskRepo.getById(USER, receipt.taskId!)?.status).toBe('cancelled')
    expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.state).toBe('completed')
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    expect(taskRunnersByChat.size).toBe(0)
    expect(localScheduleService.list(scope, AGENT)[0].binding?.last?.status).toBe('cancelled')
    check(BASE + 120000)
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(2)
  })
  it('suspends changed definitions and refuses a stale review, while preserving old occurrence history', async () => {
    const token = review(), binding = enable()
    check(); await settled(binding.id)
    definition.prompt = 'Changed instructions'
    expect(localScheduleService.list(scope, AGENT)[0].binding).toMatchObject({ enabled: false, reason: expect.stringContaining('changed') })
    expect(() => localScheduleService.enable(scope, token, BASE + 120000)).toThrow('changed')
    localScheduleService.enable(scope, review(), BASE + 120000)
    const next = localScheduleRepo.get(USER, binding.id)!
    expect(next.jobId).not.toBe(binding.jobId)
    expect(next.jobIds).toEqual([binding.jobId, next.jobId])
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    check(BASE + 120000)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })
  it('preserves civil dedupe through fall DST and disable/re-enable, then catches up once', async () => {
    definition.timezone = 'Europe/Berlin'; definition.cron_string = '30 2 * * *'
    const first = Date.parse('2026-10-25T00:30:00Z')
    const binding = enable(first - 60000)
    check(first); await settled(binding.id)
    localScheduleService.disable(scope, binding.id)
    localScheduleService.enable(scope, review(), first + 30 * 60000)
    check(first + 60 * 60000)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    expect(driverRun).toHaveBeenCalledTimes(1)
    const watermark = localScheduleRepo.get(USER, binding.id)!.watermark
    check(first - 60000)
    expect(localScheduleRepo.get(USER, binding.id)!.watermark).toBe(watermark)
    check(first + 3 * 86400000)
    await settled(binding.id)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(2)
    expect(driverRun).toHaveBeenCalledTimes(2)
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ scheduledFor: Date.parse('2026-10-26T01:30:00Z'), triggerKind: 'catch_up' })
  })
  it('rejects stale profile review and cascades only the removed profile’s local records', async () => {
    const binding = enable()
    check(); await settled(binding.id)
    userRepo.insert({ id: 'other', type: 'local_user', username: 'other', displayName: 'Other' })
    expect(() => localScheduleService.enable({ ...scope, profileUserId: 'other' }, review(), BASE)).toThrow('profile changed')
    expect(() => localScheduleService.disable({ ...scope, profileUserId: 'other' }, binding.id)).toThrow('another profile')
    userRepo.deleteWithCascade(USER)
    expect(localScheduleRepo.list(USER)).toEqual([])
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    expect(userRepo.get('other')).toBeDefined()
  })
  it.each(['command', 'duplicate', 'disabled', 'missing', 'job'] as const)('suspends admission for %s changes without silently recreating work', (change) => {
    const binding = enable()
    if (change === 'command') definition.schedule_type = 'script_trigger'
    if (change === 'disabled') definition.enabled = false
    if (change === 'missing') state.get.mockImplementation(() => { throw new Error('Folder unavailable') })
    if (change === 'duplicate') state.get.mockImplementation(() => ({ id: AGENT, kind: 'kit', enabled: true, readiness: 'ok', manifest: { id: MANIFEST, schedules: [definition, definition] } }))
    if (change === 'job') jobsRepo.update(USER, binding.jobId, { prompt: 'Edited Job' })
    check()
    expect(localScheduleRepo.get(USER, binding.id)?.enabled).toBe(change === 'missing')
    expect(jobRunsRepo.listByJob(USER, binding.jobId)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
  })
  it('does not admit a minute whose fresh folder preflight ran past its boundary', () => {
    const binding = enable()
    let now = BASE + 60000
    const get = state.get.getMockImplementation()!
    state.get.mockImplementation((...args) => { now += 60000; return get(...args) })
    localScheduleService.check(scope, () => true, () => now)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
  })
  it('refuses duplicate names introduced between the review check and final folder read', () => {
    const token = review()
    const get = state.get.getMockImplementation()!
    state.get.mockImplementationOnce(get).mockImplementationOnce(() => ({ ...get(), manifest: { id: MANIFEST, schedules: [definition, definition] } }))
    expect(() => localScheduleService.enable(scope, token, BASE)).toThrow('no longer unique')
    expect(localScheduleRepo.list(USER)).toEqual([])
    expect(jobsRepo.list(USER)).toEqual([])
  })
})

describe('scheduled shell commands', () => {
  beforeEach(() => {
    definition.schedule_type = 'script_trigger'
    definition.command = 'printf "OK"'
    state.runScheduled.mockResolvedValue(commandOutcome())
  })

  it.each([
    ['trimmed exact output', ' OK\n', ''],
    ['stderr warning', 'OK', 'A warning on stderr']
  ])('completes quietly for %s without generating any task or job', async (_label, stdout, stderr) => {
    const outcome = commandOutcome({ stdout, stderr })
    state.runScheduled.mockResolvedValue(outcome)
    const binding = enable()
    expect(binding.jobId).toBe('')
    check(); check()
    const receipt = await settled(binding.id)
    expect(receipt).toMatchObject({ status: 'completed', resultKind: 'quiet_ok', commandOutcome: outcome, taskId: null, chatId: null, runId: null, finishedAt: outcome.finishedAt })
    expect(state.runScheduled).toHaveBeenCalledExactlyOnceWith(USER, AGENT, definition.command, expect.any(AbortSignal))
    expect(driverRun).not.toHaveBeenCalled()
    expect(taskRepo.list(USER)).toEqual([])
    expect(jobsRepo.list(USER)).toEqual([])
    expect(localScheduleRepo.get(USER, binding.id)?.lastCompletedAt).toBe(outcome.finishedAt)
  })

  it.each([
    ['empty stdout', { stdout: '' }],
    ['lowercase', { stdout: 'ok' }],
    ['additional stdout', { stdout: 'OK extra' }],
    ['nonzero exit', { stdout: 'OK', exitCode: 1 }],
    ['truncated stdout', { stdout: 'OK', stdoutTruncated: true }]
  ])('creates one follow-up with durable execution context for %s', async (_label, patch) => {
    const outcome = commandOutcome({ ...patch, stderr: 'Literal {{goal}} warning' })
    state.runScheduled.mockResolvedValue(outcome)
    const binding = enable()
    const prepare = scriptRuntimeService.prepareJob
    vi.spyOn(scriptRuntimeService, 'prepareJob').mockImplementation((...args) => {
      expect(localScheduleRepo.latest(USER, binding.id)?.commandOutcome).toEqual(outcome)
      return prepare(...args)
    })
    check(); check()
    await settled(binding.id)
    check() // Persist reconciliation of the completed follow-up task.
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    expect(receipt).toMatchObject({ status: 'completed', resultKind: 'agent_started', commandOutcome: outcome, taskId: expect.any(String) })
    expect(state.runScheduled).toHaveBeenCalledTimes(1)
    expect(driverRun).toHaveBeenCalledTimes(1)
    const wire = driverRun.mock.calls[0][2].wireContent
    for (const text of [definition.name, definition.command!, '2026-09-12T09:01:00.000Z', `Exit code: ${outcome.exitCode}`, 'execution output', outcome.stdout, outcome.stderr]) expect(wire).toContain(text)
    const live = localScheduleRepo.get(USER, binding.id)!
    expect(jobsRepo.getById(USER, live.jobId)?.prompt).not.toContain(outcome.stderr)
    expect(taskRepo.getById(USER, receipt.taskId!)?.goal).toContain(outcome.stderr)
    expect(live.jobIds).toEqual([live.jobId])
  })

  it('keeps each follow-up input separate while reusing the reviewed generated job', async () => {
    state.runScheduled.mockResolvedValueOnce(commandOutcome({ stdout: 'First result' })).mockResolvedValueOnce(commandOutcome({ stdout: 'Second result' }))
    const binding = enable()
    check()
    const first = await settled(binding.id)
    const firstBinding = localScheduleRepo.get(USER, binding.id)!
    const job = jobsRepo.getById(USER, firstBinding.jobId)!
    check(BASE + 120000)
    const second = await settled(binding.id)
    expect(localScheduleRepo.get(USER, binding.id)?.jobId).toBe(job.id)
    expect(jobsRepo.getById(USER, job.id)).toEqual(job)
    expect(taskRepo.getById(USER, first.taskId!)?.goal).toContain('First result')
    expect(taskRepo.getById(USER, second.taskId!)?.goal).toContain('Second result')
    expect(driverRun).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['spawn failure', { exitCode: null, spawnError: 'No executable found' }],
    ['timeout', { exitCode: null, timedOut: true }]
  ])('records %s and consumes the occurrence without a follow-up or automatic retry', async (_label, patch) => {
    const outcome = commandOutcome(patch)
    state.runScheduled.mockResolvedValue(outcome)
    const binding = enable()
    check()
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('failed'))
    check()
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ resultKind: 'execution_error', commandOutcome: outcome, finishedAt: outcome.finishedAt })
    expect(state.runScheduled).toHaveBeenCalledTimes(1)
    expect(driverRun).not.toHaveBeenCalled()
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(BASE + 120000)
  })

  it('returns admission immediately, reserves active commands, and supports Stop with retained output', async () => {
    state.runScheduled.mockImplementation((_user, _agent, _command, signal: AbortSignal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(commandOutcome({ aborted: true, exitCode: null, stdout: 'Partial output' })), { once: true })
    }))
    const binding = enable()
    check()
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    expect(receipt.status).toBe('dispatched')
    // A running command does not hold back the next due occurrence.
    check(BASE + 5 * 60000)
    const next = localScheduleRepo.latest(USER, binding.id)!
    expect(next).toMatchObject({ status: 'dispatched', triggerKind: 'catch_up' })
    expect(next.id).not.toBe(receipt.id)
    expect(state.runScheduled).toHaveBeenCalledTimes(2)
    localScheduleService.stop(scope, { profileUserId: USER, bindingId: binding.id, occurrenceId: receipt.id })
    await vi.waitFor(() => expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.status).toBe('cancelled'))
    expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.commandOutcome).toMatchObject({ aborted: true, stdout: 'Partial output' })
    // Stop is per occurrence.
    expect(localScheduleRepo.occurrence(USER, binding.id, next.civilKey)?.status).toBe('dispatched')
    localScheduleService.stop(scope, { profileUserId: USER, bindingId: binding.id, occurrenceId: next.id })
    await vi.waitFor(() => expect(localScheduleRepo.occurrence(USER, binding.id, next.civilKey)?.status).toBe('cancelled'))
    expect(driverRun).not.toHaveBeenCalled()
    expect(taskRepo.list(USER)).toEqual([])
  })

  it('requires explicit recovery after profile cancellation and never repeats the uncertain command', async () => {
    state.runScheduled.mockImplementation((_user, _agent, _command, signal: AbortSignal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(commandOutcome({ aborted: true, exitCode: null, started: true })), { once: true })
    }))
    const binding = enable()
    check()
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    localScheduleService.cancelCommands()
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('interrupted'))
    // The uncertain occurrence is never replayed; the next one runs on time.
    state.runScheduled.mockResolvedValue(commandOutcome())
    check(BASE + 120000)
    await settled(binding.id)
    expect(state.runScheduled).toHaveBeenCalledTimes(2)
    expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.status).toBe('interrupted')
    localScheduleService.stop(scope, { profileUserId: USER, bindingId: binding.id, occurrenceId: receipt.id })
    expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.status).toBe('cancelled')
    expect(state.runScheduled).toHaveBeenCalledTimes(2)
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('cancels a command stopped while still queued for its agent and admits the next occurrence', async () => {
    state.runScheduled.mockImplementation((_user, _agent, _command, signal: AbortSignal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(commandOutcome({ aborted: true, exitCode: null, stdout: '', started: false })), { once: true })
    }))
    const binding = enable()
    check()
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    localScheduleService.cancelCommands()
    await vi.waitFor(() => expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.status).toBe('cancelled'))
    expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)).toMatchObject({
      reason: 'Stopped before the command started; it will not be replayed.', commandOutcome: null })
    state.runScheduled.mockResolvedValue(commandOutcome())
    check(BASE + 120000)
    expect(localScheduleRepo.latest(USER, binding.id)?.status).not.toBe('skipped_overlap')
    await settled(binding.id)
    expect(state.runScheduled).toHaveBeenCalledTimes(2)
    expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('completed')
  })

  it('treats a missing exit code as uncertain and leaves it for review while later occurrences still run', async () => {
    const outcome = commandOutcome({ exitCode: null, stdout: 'Partial work before external termination' })
    state.runScheduled.mockResolvedValue(outcome)
    const binding = enable()
    check()
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('interrupted'))
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    expect(receipt).toMatchObject({ commandOutcome: outcome, taskId: null, reason: expect.stringContaining('Its outcome is uncertain') })
    state.runScheduled.mockResolvedValue(commandOutcome())
    check(BASE + 120000)
    await settled(binding.id)
    expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.status).toBe('interrupted')
    expect(state.runScheduled).toHaveBeenCalledTimes(2)
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('reconciles an orphan command after restart as interrupted instead of rerunning it', async () => {
    const binding = enable()
    check()
    const completed = await settled(binding.id)
    // Simulate the durable state left by a process exit after dispatch intent.
    localScheduleRepo.updateOccurrence(USER, completed.id, { status: 'dispatched', commandOutcome: null, resultKind: null, finishedAt: null })
    check(BASE + 120000)
    expect(localScheduleRepo.occurrence(USER, binding.id, completed.civilKey)).toMatchObject({ status: 'interrupted', reason: expect.stringContaining('outcome is uncertain') })
    // A new occurrence, not a rerun of the orphaned one.
    const next = await settled(binding.id)
    expect(next.civilKey).not.toBe(completed.civilKey)
    expect(state.runScheduled).toHaveBeenCalledTimes(2)
  })

  it('does not launch a follow-up under a changed profile even when the command completed successfully', async () => {
    let finish!: (outcome: ScheduleCommandOutcome) => void
    state.runScheduled.mockImplementation(() => new Promise<ScheduleCommandOutcome>(resolve => { finish = resolve }))
    const binding = enable()
    let current = true
    localScheduleService.check(scope, () => current, () => BASE + 60000)
    current = false
    finish(commandOutcome({ stdout: 'Needs attention' }))
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('interrupted'))
    expect(localScheduleRepo.latest(USER, binding.id)?.commandOutcome?.stdout).toBe('Needs attention')
    expect(jobsRepo.list(USER)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('retains command results through follow-up preparation failure without replaying the command', async () => {
    const outcome = commandOutcome({ stdout: 'Needs attention' })
    state.runScheduled.mockResolvedValue(outcome)
    vi.spyOn(scriptRuntimeService, 'prepareJob').mockImplementation(() => { throw new Error('Task storage unavailable') })
    const binding = enable()
    check()
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('interrupted'))
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ commandOutcome: outcome, taskId: null, reason: 'Task storage unavailable' })
    expect(jobsRepo.list(USER)).toEqual([])
    const first = localScheduleRepo.latest(USER, binding.id)!
    check(); check(BASE + 120000)
    // The next occurrence runs its own command; the first is not replayed.
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.civilKey).not.toBe(first.civilKey))
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('interrupted'))
    expect(localScheduleRepo.occurrence(USER, binding.id, first.civilKey)).toMatchObject({ status: 'interrupted', commandOutcome: outcome })
    expect(state.runScheduled).toHaveBeenCalledTimes(2)
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('preserves the prepared task and command result when follow-up launch fails', async () => {
    state.runScheduled.mockResolvedValue(commandOutcome({ stdout: 'Needs attention' }))
    const prepare = scriptRuntimeService.prepareJob
    vi.spyOn(scriptRuntimeService, 'prepareJob').mockImplementation((...args) => ({ ...prepare(...args), launch() { throw new Error('Profile changed before launch') } }))
    const binding = enable()
    check()
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('interrupted'))
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    expect(receipt).toMatchObject({ resultKind: 'agent_started', taskId: expect.any(String), commandOutcome: expect.objectContaining({ stdout: 'Needs attention' }) })
    expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.state).toBe('interrupted')
    check(BASE + 120000)
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.civilKey).not.toBe(receipt.civilKey))
    await vi.waitFor(() => expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('interrupted'))
    expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.status).toBe('interrupted')
    expect(state.runScheduled).toHaveBeenCalledTimes(2)
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('suspends a changed command catalog revision before shell admission', () => {
    definition.command = '/run:check'
    const binding = enable()
    state.resolveCommand.mockReturnValue({ localCommand: 'changed command', revision: 'different-review' })
    check()
    expect(localScheduleRepo.get(USER, binding.id)).toMatchObject({ enabled: false, reason: expect.stringContaining('changed') })
    expect(state.runScheduled).not.toHaveBeenCalled()
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('paginates quiet history and enforces active profile ownership for history and Stop', async () => {
    const binding = enable()
    check()
    const receipt = await settled(binding.id)
    for (let index = 1; index <= 51; index++) localScheduleRepo.insertOccurrence({ ...receipt,
      id: `history-${index}`, civilKey: `historical-civil-${index}`, utcMinute: receipt.utcMinute + index })
    const first = localScheduleService.history(scope, { profileUserId: USER, bindingId: binding.id })
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).toBe('50')
    expect(first.items[0].id).toBe('history-51')
    const second = localScheduleService.history(scope, { profileUserId: USER, bindingId: binding.id, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(52)
    expect(() => localScheduleService.history({ ...scope, profileUserId: 'other' }, { profileUserId: USER, bindingId: binding.id })).toThrow('profile changed')
    expect(() => localScheduleService.history(scope, { profileUserId: USER, bindingId: binding.id, cursor: '-1' })).toThrow('Invalid history cursor')
    expect(() => localScheduleService.stop({ ...scope, profileUserId: 'other' }, { profileUserId: USER, bindingId: binding.id, occurrenceId: receipt.id })).toThrow('profile changed')
  })
})
