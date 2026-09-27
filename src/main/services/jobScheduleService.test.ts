import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { JobScheduleSaveInput } from '../../shared/localJobSchedules'
import type { JobRow } from '../db/jobs'
import type { RunHandle } from './runExecutionService'

const state = vi.hoisted(() => ({ database: null as TestDatabase | null, prepare: vi.fn(), launch: vi.fn(), interrupt: vi.fn(), interruptOrphan: vi.fn() }))
vi.mock('../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => ({ deviceId: 'this-device' }) } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))
vi.mock('./jobExecution/scheduled', () => ({ prepareScheduledJob: state.prepare, interruptScheduledOrdinaryJob: state.interruptOrphan }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: { get: vi.fn() } }))
vi.mock('./localAgents/commandService', () => ({ commandService: {} }))
vi.mock('./scriptRuntimeService', () => ({ scriptRuntimeService: {} }))
vi.mock('./taskRuntimeService', () => ({ taskRuntimeService: { cancel: vi.fn() } }))
vi.mock('./runExecutionService', () => ({ runExecutionService: { isRunning: () => false, cancelChat: vi.fn() } }))
vi.mock('./taskService', () => ({ taskService: { setStatus: vi.fn() } }))
const { jobScheduleService } = await import('./jobScheduleService')
const { localScheduleService } = await import('./localScheduleService')
const { localScheduleRepo } = await import('../db/localSchedules')
const { jobsRepo, jobRunsRepo, jobAgentRepo, jobMcpRepo } = await import('../db/jobs')
const { taskRepo } = await import('../db/tasks')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { activeRunsByChat } = await import('./runExecutionState')
const USER = '__default__'
const scope = { profileUserId: USER, settingsUserId: USER }
const BASE = Date.parse('2026-09-14T07:00:00Z')
let job: JobRow
function prepareRows(source = job) {
  const { chatId, runId } = jobRunsRepo.createLocalChatAndRun({ userId: USER, jobId: source.id, title: source.title,
    prompt: source.prompt, rootAgentId: null, router: 'direct', modeId: null, providerId: null, modelId: null,
    onDemandAgentIds: [], onDemandMcpIds: [] })
  const task = taskRepo.create(USER, { title: source.title, goal: source.prompt, status: 'in_progress', chatId, jobId: source.id, jobRunId: runId })
  jobRunsRepo.setTaskId(runId, task.id)
  return { chatId, runId, taskId: task.id,
    launch() { state.launch(); taskRunnersByChat.set(chatId, { userId: USER, taskId: task.id, id: 'test-running', working: true, cancel() {} }) },
    interrupt(reason: string) { state.interrupt(reason); taskRepo.update(USER, task.id, { status: 'blocked', errorMessage: reason }) } }

}
function input(patch: Partial<JobScheduleSaveInput> = {}): JobScheduleSaveInput {
  return { profileUserId: USER, jobId: job.id, jobRevision: jobScheduleService.list(scope, job.id).jobRevision,
    name: 'Weekday report', cron: '0 8 * * 1-5', timezone: 'UTC', enabled: true, ...patch }
}
function save(patch: Partial<JobScheduleSaveInput> = {}, now = BASE) {
  const result = jobScheduleService.save(scope, input(patch), now)
  return localScheduleRepo.get(USER, result.items.find(row => row.name === (patch.name ?? 'Weekday report'))!.binding!.id)!
}
function mutation(binding: ReturnType<typeof save>) { return { profileUserId: USER, jobId: job.id, id: binding.id, revision: binding.revision } }
const check = (at: number) => jobScheduleService.check(scope, () => true, () => at)
beforeEach(() => {
  state.database = createTestDatabase()
  const created = jobsRepo.create(USER, { type: 'local', title: 'Source job', prompt: 'Read the original {{literal}} prompt.' })
  job = jobsRepo.getById(USER, created.id)!
  state.prepare.mockReset().mockImplementation(async (_scope, source) => () => prepareRows(source))
  state.launch.mockReset().mockImplementation(() => { expect(state.database!.sqlite.inTransaction).toBe(false) })
  state.interrupt.mockReset()
  state.interruptOrphan.mockReset().mockImplementation((userId, taskId, _chatId, _runId, reason) => taskRepo.update(userId, taskId, { status: 'blocked', errorMessage: reason }))
})
afterEach(() => { vi.restoreAllMocks(); taskRunnersByChat.clear(); activeRunsByChat.clear(); state.database?.close(); state.database = null })

describe('device-local Job schedules', () => {
  it('stores timing locally and prepares the unchanged source Job with one catch-up', async () => {
    const binding = save()
    expect(binding).toMatchObject({ manifestId: `job:${job.id}`, jobId: job.id, jobIds: [job.id], nextDueAt: Date.parse('2026-09-14T08:00:00Z') })
    const observed = Date.parse('2026-09-21T11:00:00Z')
    await check(observed); await check(observed)
    expect(state.prepare).toHaveBeenCalledTimes(1)
    expect(state.launch).toHaveBeenCalledTimes(1)
    expect(jobsRepo.list(USER)).toEqual([job])
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    expect(receipt).toMatchObject({ status: 'dispatched', triggerKind: 'catch_up', scheduledFor: Date.parse('2026-09-14T08:00:00Z'), coveredThrough: observed })
    expect(jobRunsRepo.getById(USER, receipt.runId!)).toMatchObject({ jobId: job.id, taskId: receipt.taskId })
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(Date.parse('2026-09-22T08:00:00Z'))
  })

  it('starts newly enabled and edited schedules strictly after their reviewed time', async () => {
    const binding = save({}, Date.parse('2026-09-21T11:00:00Z'))
    expect(binding.nextDueAt).toBe(Date.parse('2026-09-22T08:00:00Z'))
    jobScheduleService.disable(scope, mutation(binding))
    const disabled = localScheduleRepo.get(USER, binding.id)!
    jobScheduleService.enable(scope, { ...mutation(disabled), jobRevision: input().jobRevision }, Date.parse('2026-09-28T11:00:00Z'))
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(Date.parse('2026-09-29T08:00:00Z'))
    expect(state.prepare).not.toHaveBeenCalled()
  })

  it('preserves binding/history on rename and rejects a stale editor revision', async () => {
    const binding = save()
    await check(Date.parse('2026-09-14T08:00:00Z'))
    save({ id: binding.id, revision: binding.revision, name: 'Renamed report' }, BASE + 120000)
    expect(localScheduleRepo.get(USER, binding.id)?.name).toBe('Renamed report')
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    expect(() => jobScheduleService.save(scope, input({ id: binding.id, revision: binding.revision }), BASE)).toThrow('schedule changed')
  })

  it('rejects an old Job review token after execution instructions change', () => {
    const form = input()
    jobsRepo.update(USER, job.id, { prompt: 'Changed prompt' })
    expect(() => jobScheduleService.save(scope, form, BASE)).toThrow('Job changed')
    expect(localScheduleRepo.list(USER)).toEqual([])
  })

  it.each(['prompt', 'agents', 'tools', 'script'] as const)('suspends reviewed execution after %s change', async field => {
    const script = (prompt: string) => ({ version: 1 as const, agents: { worker: { kind: 'agent' as const, source: 'folder' as const, manifestId: 'alpha', name: 'Alpha' } },
      steps: [{ id: 'run', agent: 'worker', prompt }] })
    if (field === 'script') {
      jobsRepo.update(USER, job.id, { router: 'script', script: script('{{goal}}') })
      job = jobsRepo.getById(USER, job.id)!
    }
    const binding = save()
    if (field === 'script') jobsRepo.update(USER, job.id, { script: script('Changed step {{goal}}') })
    else if (field === 'prompt') jobsRepo.update(USER, job.id, { prompt: 'Changed prompt' })
    else if (field === 'agents') {
      state.database!.raw.prepare("INSERT INTO agents (id,user_id,name,protocol,enabled,created_at) VALUES ('worker',?,'Worker','acp',1,1)").run(USER)
      jobAgentRepo.setAgentIds(job.id, ['worker'])
    } else {
      state.database!.raw.prepare("INSERT INTO mcp_providers (id,user_id,name,transport_type,enabled,created_at) VALUES ('tool',?,'Tool','stdio',1,1)").run(USER)
      jobMcpRepo.setProviderIds(job.id, ['tool'])
    }
    expect(jobScheduleService.list(scope, job.id).items[0].binding?.enabled).toBe(false)
    await check(Date.parse('2026-09-14T08:00:00Z'))
    expect(localScheduleRepo.get(USER, binding.id)).toMatchObject({ enabled: false, reason: 'The Job changed since this schedule was turned on. Turn it on again to use the Job as it is now.' })
    expect(state.prepare).not.toHaveBeenCalled()
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
  })

  it('launches an admitted run even when a minute boundary passes between claim and launch', async () => {
    const binding = save()
    let clock = Date.parse('2026-09-14T08:00:30Z')
    state.prepare.mockImplementation(async (_scope, source) => () => { clock += 60000; return prepareRows(source) })
    await jobScheduleService.check(scope, () => true, () => clock)
    expect(state.launch).toHaveBeenCalledTimes(1)
    expect(state.interrupt).not.toHaveBeenCalled()
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ status: 'dispatched', reason: null })
  })

  it.each(['in_progress', 'blocked'] as const)('blocks a due occurrence behind a %s manual source Job run without preflight', async status => {
    const binding = save(), manual = prepareRows()
    taskRepo.update(USER, manual.taskId, { status })
    await check(Date.parse('2026-09-21T11:00:00Z'))
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ status: 'skipped_overlap', taskId: manual.taskId })
    expect(state.prepare).not.toHaveBeenCalled()
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(Date.parse('2026-09-22T08:00:00Z'))
  })

  it('blocks overlap across two schedules for the same source Job', async () => {
    const first = save(), second = save({ name: 'Another schedule' })
    await check(Date.parse('2026-09-14T08:00:00Z'))
    expect(state.launch).toHaveBeenCalledTimes(1)
    expect([localScheduleRepo.latest(USER, first.id)?.status, localScheduleRepo.latest(USER, second.id)?.status].sort())
      .toEqual(['dispatched', 'skipped_overlap'])
  })

  it.each(['terminal', 'deleted'] as const)('keeps overlap while an ordinary %s task’s canceled driver is still stopping', async stateOfTask => {
    const binding = save(), manual = prepareRows()
    taskRepo.update(USER, manual.taskId, { status: 'cancelled' })
    jobRunsRepo.updateStatus(manual.runId, 'cancelled')
    if (stateOfTask === 'deleted') taskRepo.softDelete(USER, manual.taskId)
    activeRunsByChat.set(manual.chatId, { id: 'stopping-turn' } as RunHandle)
    expect(localScheduleRepo.unfinishedRuns(USER, [job.id])).toEqual([])
    await check(Date.parse('2026-09-14T08:00:00Z'))
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ status: 'skipped_overlap', taskId: manual.taskId, reason: expect.stringContaining('still stopping') })
    expect(state.prepare).not.toHaveBeenCalled()
    expect(state.launch).not.toHaveBeenCalled()
    activeRunsByChat.delete(manual.chatId)
    await check(Date.parse('2026-09-15T08:00:00Z'))
    expect(state.launch).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent checks while asynchronous preflight is pending', async () => {
    const binding = save()
    let finish!: (value: () => ReturnType<typeof prepareRows>) => void
    state.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = check(Date.parse('2026-09-14T08:00:00Z'))
    await check(Date.parse('2026-09-14T08:00:00Z'))
    expect(state.prepare).toHaveBeenCalledTimes(1)
    finish(() => prepareRows()); await first
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
  })

  it('consumes failed preparation without retaining partial task/run rows or retrying on focus', async () => {
    const binding = save()
    state.prepare.mockResolvedValueOnce(() => { prepareRows(); throw new Error('Preparation refused') })
    const due = Date.parse('2026-09-14T08:00:00Z')
    await check(due); await check(due)
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ status: 'failed', reason: 'Preparation refused', taskId: null })
    expect(jobRunsRepo.listByJob(USER, job.id)).toEqual([])
    expect(taskRepo.list(USER)).toEqual([])
    expect(state.launch).not.toHaveBeenCalled()
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(Date.parse('2026-09-15T08:00:00Z'))
  })

  it('preserves a committed failed launch as interrupted and does not relaunch it', async () => {
    const binding = save()
    state.launch.mockImplementationOnce(() => { throw new Error('Launch refused') })
    const due = Date.parse('2026-09-14T08:00:00Z')
    await check(due); await check(due)
    expect(state.interrupt).toHaveBeenCalledWith('Launch refused')
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ status: 'interrupted', reason: 'Launch refused' })
    expect(jobRunsRepo.listByJob(USER, job.id)).toHaveLength(1)
    expect(state.launch).toHaveBeenCalledTimes(1)
  })

  it('invalidates preflight after a profile switch without claiming or launching', async () => {
    const binding = save(); let current = true
    state.prepare.mockImplementationOnce(async () => { current = false; return () => prepareRows() })
    await jobScheduleService.check(scope, () => current, () => Date.parse('2026-09-14T08:00:00Z'))
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    expect(localScheduleRepo.get(USER, binding.id)?.nextDueAt).toBe(binding.nextDueAt)
    expect(state.launch).not.toHaveBeenCalled()
  })

  it('rejects profile, impossible rule, duplicate name, and remote Job mutations', () => {
    expect(() => jobScheduleService.save(scope, input({ profileUserId: 'another' }), BASE)).toThrow('profile changed')
    expect(() => jobScheduleService.save(scope, input({ cron: '0 8 30 2 *' }), BASE)).toThrow('no possible occurrence')
    save()
    expect(() => save()).toThrow('unique')
    const remote = jobsRepo.create(USER, { type: 'cinna_task', title: 'Remote', prompt: 'Remote work' })
    expect(() => jobScheduleService.list(scope, remote.id)).toThrow('Only local Jobs')
  })

  it('deletes a schedule without deleting history and permits a new rule with its old name', async () => {
    const binding = save(); await check(Date.parse('2026-09-14T08:00:00Z'))
    jobScheduleService.delete(scope, mutation(binding))
    expect(jobScheduleService.list(scope, job.id).items).toEqual([])
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    expect(jobScheduleService.history(scope, { profileUserId: USER, bindingId: binding.id }).items).toHaveLength(1)
    expect(save().id).not.toBe(binding.id)
  })

  it('pages durable history and rejects another profile', async () => {
    const binding = save(); await check(Date.parse('2026-09-14T08:00:00Z'))
    const original = localScheduleRepo.latest(USER, binding.id)!
    for (let index = 1; index <= 52; index++) localScheduleRepo.insertOccurrence({ ...original,
      id: `page-${index}`, civilKey: `page-${index}`, utcMinute: original.utcMinute + index, status: 'failed', taskId: null, runId: null, chatId: null })
    const first = jobScheduleService.history(scope, { profileUserId: USER, bindingId: binding.id })
    expect(first.items).toHaveLength(50)
    expect(first.items[0].id).toBe('page-52')
    const second = jobScheduleService.history(scope, { profileUserId: USER, bindingId: binding.id, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(3)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(53)
    expect(() => jobScheduleService.history(scope, { profileUserId: 'other', bindingId: binding.id })).toThrow('profile changed')
  })

  it('invalidates preflight after disabling without creating an occurrence', async () => {
    const binding = save()
    state.prepare.mockImplementationOnce(async () => {
      jobScheduleService.disable(scope, mutation(binding))
      return () => prepareRows()
    })
    await check(Date.parse('2026-09-14T08:00:00Z'))
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    expect(state.launch).not.toHaveBeenCalled()
  })

  it.each(['prepared', 'dispatched'] as const)('recovers an orphaned %s ordinary occurrence even after disabling', async status => {
    const binding = save(); await check(Date.parse('2026-09-14T08:00:00Z'))
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    taskRunnersByChat.clear()
    localScheduleRepo.updateOccurrence(USER, receipt.id, { status })
    jobScheduleService.disable(scope, mutation(binding))
    await check(Date.parse('2026-09-14T08:01:00Z'))
    expect(state.interruptOrphan).toHaveBeenCalledTimes(1)
    expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('interrupted')
    expect(taskRepo.getById(USER, receipt.taskId!)?.status).toBe('blocked')
    expect(state.launch).toHaveBeenCalledTimes(1)
  })

  it('does not mistake a handed-off remote source task for interrupted local execution', async () => {
    const binding = save(); await check(Date.parse('2026-09-14T08:00:00Z'))
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    taskRunnersByChat.clear()
    taskRepo.update(USER, receipt.taskId!, { executor: 'remote' })
    await check(Date.parse('2026-09-14T08:01:00Z'))
    expect(state.interruptOrphan).not.toHaveBeenCalled()
    expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('dispatched')
    expect(taskRepo.getById(USER, receipt.taskId!)?.status).toBe('in_progress')
  })

  it('leaves work taken over by another desktop running and continues polling unrelated Jobs', async () => {
    const binding = save(); await check(Date.parse('2026-09-14T08:00:00Z'))
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    taskRunnersByChat.clear()
    taskRepo.update(USER, receipt.taskId!, { executor: 'desktop', executorDevice: 'another-device' })
    const created = jobsRepo.create(USER, { type: 'local', title: 'Another Job', prompt: 'Independent work' })
    job = jobsRepo.getById(USER, created.id)!
    const unrelated = save()
    await check(Date.parse('2026-09-15T08:00:00Z'))
    expect(state.interruptOrphan).not.toHaveBeenCalled()
    expect(localScheduleRepo.occurrence(USER, binding.id, receipt.civilKey)?.status).toBe('dispatched')
    expect(taskRepo.getById(USER, receipt.taskId!)).toMatchObject({ status: 'in_progress', executorDevice: 'another-device' })
    expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('skipped_overlap')
    expect(localScheduleRepo.latest(USER, unrelated.id)?.status).toBe('dispatched')
    expect(state.launch).toHaveBeenCalledTimes(2)
  })

  it('source Job deletion stops admission and Job bindings never enter agent scheduling', async () => {
    const binding = save()
    localScheduleService.check(scope, () => true, () => Date.parse('2026-09-14T08:00:00Z'))
    expect(state.prepare).not.toHaveBeenCalled()
    jobsRepo.softDelete(USER, job.id)
    await check(Date.parse('2026-09-14T08:00:00Z'))
    expect(localScheduleRepo.get(USER, binding.id)?.enabled).toBe(false)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
  })
})
