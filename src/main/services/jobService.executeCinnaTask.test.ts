import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { TaskError } from '../errors'
import type { RemoteTaskAdapter } from '../tasks/adapters/adapter'

/**
 * A job that runs on a service, after step 11 folded it onto the adapter seam.
 *
 * **What changed, and why it is worth its own file.** Until step 11 this path
 * called one hardcoded server directly — `cinnaApiService.createTask` with
 * `auto_execute: true`, a `job_runs` row, and no task at all — so a cinna job
 * run was the one run in the app with nothing in the tasks table: invisible to
 * the inbox, to the task page, and to the user's other devices. It is now a
 * task like every other run, handed across the seam by whichever adapter the
 * profile can use, and its run status is *derived* from its task rather than
 * fetched separately.
 *
 * Three layers are real — the service, the adapter, the database — and only the
 * socket is replaced, for the reason `taskSyncService.test.ts` gives: a mocked
 * adapter would assert that this service calls a mock in an order this file
 * also chose, and the things worth pinning here (an orphan cleaned up after a
 * refused hand-over, a status that walks the remote's transition table) are
 * only observable against something that refuses the way cinna refuses.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  userData: '',
  adapters: [] as RemoteTaskAdapter[]
}))

vi.mock('electron', () => ({ app: { getPath: () => holder.userData } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../auth/scope', () => ({
  getSettingsScopeUserId: () => '__default__',
  getProfileScopeUserId: () => '__default__',
  getAgentLookupScope: () => ['__default__']
}))
vi.mock('./cinnaApiService', () => ({
  getCinnaServerUrl: () => null,
  cinnaApiService: {}
}))
vi.mock('./syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
vi.mock('../tasks/adapters', async () => {
  const adapter = await import('../tasks/adapters/adapter')
  const nullAdapter = await import('../tasks/adapters/nullAdapter')
  return {
    ...adapter,
    allAdapters: () => holder.adapters,
    adapterFor: (id: string) =>
      holder.adapters.find((a) => a.id === id) ?? nullAdapter.createNullAdapter(id)
  }
})

const { jobService } = await import('./jobService')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { taskRepo } = await import('../db/tasks')
const { taskService } = await import('./taskService')
const { taskSyncService } = await import('./taskSyncService')
const { createCinnaTaskAdapter } = await import('../tasks/adapters/cinnaTaskAdapter')
const { createFakeCinnaServer } = await import('../tasks/adapters/testSupport/fakeCinnaServer')

const USER = '__default__'
const JOB_ID = 'job-1'

let cinna: ReturnType<typeof createFakeCinnaServer>

type ExecuteResult = Awaited<ReturnType<typeof jobService.execute>>
type ServiceRun = Extract<ExecuteResult, { type: 'cinna_task' }>

/**
 * Run the job through the **one** entry point, and narrow.
 *
 * Through `execute` rather than `executeCinnaTask` deliberately: `job.type` is
 * the last thing that arm reads, and a test that called the branch directly
 * would keep passing on the day nothing routed to it.
 */
async function runOnService(): Promise<ServiceRun> {
  const result = await jobService.execute(USER, JOB_ID)
  if (result.type !== 'cinna_task') throw new Error(`expected a service run, got ${result.type}`)
  return result
}

function makeJob(overrides: Record<string, unknown> = {}): void {
  jobsRepo.create(USER, {
    type: 'cinna_task',
    title: 'Nightly reconciliation',
    prompt: 'Reconcile payouts for the last 7 days',
    cinnaAgentId: 'agent-on-the-service',
    cinnaPriority: 'high',
    ...overrides
  } as never)
  // `create` mints its own id; the tests want a known one.
  const [row] = jobsRepo.list(USER)
  holder.current!.raw.exec(`UPDATE jobs SET id = '${JOB_ID}' WHERE id = '${row.id}'`)
}

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.userData = mkdtempSync(join(tmpdir(), 'cinna-job-remote-'))
  cinna = createFakeCinnaServer()
  holder.adapters = [createCinnaTaskAdapter(cinna.world)]
  taskSyncService.resetCursors()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
  if (holder.userData) rmSync(holder.userData, { recursive: true, force: true })
})

describe('running a job on a service', () => {
  it('makes a task, hands it over, and records a run that points at both', async () => {
    makeJob()

    const result = await runOnService()

    const run = jobRunsRepo.getById(USER, result.runId)!
    expect(run.taskId).toBe(result.taskId)
    expect(run.cinnaTaskId).toBe(result.cinnaTaskId)

    const task = taskService.getById(USER, result.taskId)
    expect(task.executor).toBe('remote')
    expect(task.origin).toBe('local')
    // The job's configured agent, as an id in the space its kind names: an
    // agent that exists on the service and has no local `agents` row.
    expect(task.assignee).toEqual({
      agentId: 'agent-on-the-service',
      name: null,
      kind: 'remote_agent'
    })
    expect(task.priority).toBe('high')
    expect(task.jobId).toBe(JOB_ID)
    // Written after the run row exists, which is the reason `linkJobRun` is a
    // method at all: on this path the task has to come first, because the
    // adapter is given its id as `external_ref`.
    expect(task.jobRunId).toBe(result.runId)

    expect(cinna.task(result.cinnaTaskId)?.external_ref).toBe(result.taskId)
  })

  it('leaves no task and no run behind when the service will not take it', async () => {
    // The same promise `executeLocal` keeps by ordering, kept here by cleaning
    // up: a refused run leaves nothing new in the user's lists. The task cannot
    // be created second on this path — the adapter is given its id.
    cinna.refuseExecute()
    makeJob()

    await expect(jobService.execute(USER, JOB_ID)).rejects.toThrow()

    expect(jobRunsRepo.listByJob(USER, JOB_ID)).toHaveLength(0)
    expect(taskService.list(USER)).toHaveLength(0)
  })

  it('reports the service\'s refusal, not a failure of its own cleanup', async () => {
    // The cleanup is a second write on a path that has already failed once. A
    // throw from it would surface instead of the hand-over's error, so the user
    // would read a bookkeeping failure where the truth was "that service
    // refused the work".
    cinna.refuseExecute()
    makeJob()
    const removeSpy = vi.spyOn(taskService, 'remove').mockImplementation(() => {
      throw new Error('the task was already gone')
    })

    await expect(jobService.execute(USER, JOB_ID)).rejects.toThrow(
      /would not start work/
    )

    expect(removeSpy).toHaveBeenCalled()
    removeSpy.mockRestore()
  })

  it('does not delete a task the service has already started work on', async () => {
    // `handed_over` is not a refusal. The service took the work and only the
    // local record of it was lost, so the cleanup must stay out of the way —
    // there is nothing to clean up, and an agent is running.
    makeJob()
    const removeSpy = vi.spyOn(taskService, 'remove')
    const handOffSpy = vi.spyOn(taskSyncService, 'handOff').mockRejectedValueOnce(
      new TaskError('handed_over', 'That task was removed while the service was starting work.')
    )

    await expect(jobService.execute(USER, JOB_ID)).rejects.toMatchObject({
      code: 'handed_over'
    })

    expect(removeSpy).not.toHaveBeenCalled()
    handOffSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('refuses before minting a task when the profile is connected to no service', async () => {
    // The hand-over refuses too, but by then the task exists — and the cleanup
    // is a *soft* delete, so every press left a permanent row that travels to
    // the user's other devices carrying `deleted: true`.
    holder.adapters = []
    makeJob()

    await expect(jobService.execute(USER, JOB_ID)).rejects.toMatchObject({
      code: 'incomplete_setup'
    })
    expect(taskRepo.list(USER, { includeArchived: true })).toHaveLength(0)
    expect(jobRunsRepo.listByJob(USER, JOB_ID)).toHaveLength(0)
  })

  it('refuses a job with no agent, before anything is created', async () => {
    makeJob({ cinnaAgentId: null })

    await expect(jobService.execute(USER, JOB_ID)).rejects.toMatchObject({
      code: 'missing_dependency'
    })
    expect(taskService.list(USER)).toHaveLength(0)
    expect(cinna.calls()).toHaveLength(0)
  })
})

describe('refreshing a run that is executing on a service', () => {
  it('derives the run status from its task rather than fetching one of its own', async () => {
    makeJob()
    const started = await runOnService()
    expect(jobRunsRepo.getById(USER, started.runId)!.status).toBe('running')

    // The service finishes the work. Its own status walks its own table; the
    // desktop finds out by pulling the task.
    cinna.touch(started.cinnaTaskId, { status: 'completed' })

    const refreshed = await jobService.refreshCinnaRun(USER, started.runId)

    expect(refreshed.status).toBe('succeeded')
    expect(taskService.getById(USER, started.taskId).status).toBe('completed')
  })

  it('reads a blocked task as a run that is still going', async () => {
    // A run whose agent is waiting on a human has not finished and has not
    // failed. What the user has to do about it is in the inbox.
    makeJob()
    const started = await runOnService()
    cinna.touch(started.cinnaTaskId, { status: 'blocked' })

    const refreshed = await jobService.refreshCinnaRun(USER, started.runId)

    expect(refreshed.status).toBe('running')
  })

  it('gives a run from before step 11 the task it never had', async () => {
    // These rows carry the remote's id and nothing else — no task, no binding,
    // no way to reach an adapter. Keeping the old direct fetch beside the new
    // path for them would have been a second code path serving a shrinking set.
    makeJob()
    const remote = cinna.seed({ title: 'Reconcile payouts', status: 'completed' })
    const run = jobRunsRepo.create({
      jobId: JOB_ID,
      userId: USER,
      type: 'cinna_task',
      cinnaTaskId: remote.id,
      cinnaShortCode: remote.short_code,
      status: 'running'
    })

    const refreshed = await jobService.refreshCinnaRun(USER, run.id)

    const taskId = jobRunsRepo.getById(USER, run.id)!.taskId
    expect(taskId).toBeTruthy()
    const task = taskService.getById(USER, taskId!)
    expect(task.origin).toBe('remote')
    expect(task.remote?.id).toBe(remote.id)
    expect(task.status).toBe('completed')
    expect(refreshed.status).toBe('succeeded')
  })

  it('reports a run whose work was deleted on the service, and stops it running', async () => {
    // Three things arrive as a null from `pullOne` and only one is news. An
    // unbind is terminal: the service answered 404 or "not yours", so the work
    // is gone and the run will never move again. Left silent, the row polled
    // every five seconds with the job's badge lit and every manual Refresh
    // reported success.
    makeJob()
    const started = await runOnService()
    cinna.forget(started.cinnaTaskId)

    await expect(jobService.refreshCinnaRun(USER, started.runId)).rejects.toMatchObject({
      code: 'missing_dependency'
    })

    expect(jobRunsRepo.getById(USER, started.runId)!.status).toBe('failed')
    expect(taskService.getById(USER, started.taskId).remote).toBeNull()
  })

  it('says nothing when the service merely could not be reached', async () => {
    // The other two nulls. A transport failure is not news — the binding
    // survives, the run keeps its status, and the next tick tries again.
    makeJob()
    const started = await runOnService()
    cinna.behave('transport')

    const refreshed = await jobService.refreshCinnaRun(USER, started.runId)

    expect(refreshed.status).toBe('running')
    expect(taskService.getById(USER, started.taskId).remote).not.toBeNull()
  })

  it('joins the task a pull already made for the same remote id', async () => {
    // A pull creates replicas for remote tasks; a run adopting the same id
    // without asking would leave two local tasks bound to one remote task, each
    // pushing over the other.
    makeJob()
    const remote = cinna.seed({ title: 'Reconcile payouts' })
    const replica = taskService.create(USER, {
      title: 'Reconcile payouts',
      goal: 'Reconcile payouts',
      origin: 'remote',
      executor: 'remote'
    })
    taskService.bindRemote(USER, replica.id, {
      adapter: 'cinna',
      id: remote.id,
      key: remote.short_code,
      url: null,
      state: {}
    })
    const run = jobRunsRepo.create({
      jobId: JOB_ID,
      userId: USER,
      type: 'cinna_task',
      cinnaTaskId: remote.id,
      cinnaShortCode: remote.short_code,
      status: 'running'
    })

    await jobService.refreshCinnaRun(USER, run.id)

    expect(jobRunsRepo.getById(USER, run.id)!.taskId).toBe(replica.id)
    expect(taskRepo.list(USER, { includeArchived: true })).toHaveLength(1)
  })

  it('adopts at most once when two refreshes overlap', async () => {
    // Asking the registry which adapter is usable is a promise, so both calls
    // can pass the "has it a task yet" check before either writes one.
    makeJob()
    const remote = cinna.seed({ title: 'Reconcile payouts' })
    const run = jobRunsRepo.create({
      jobId: JOB_ID,
      userId: USER,
      type: 'cinna_task',
      cinnaTaskId: remote.id,
      cinnaShortCode: remote.short_code,
      status: 'running'
    })

    await Promise.all([
      jobService.refreshCinnaRun(USER, run.id),
      jobService.refreshCinnaRun(USER, run.id)
    ])

    expect(taskRepo.list(USER, { includeArchived: true })).toHaveLength(1)
  })

  it('adopts at most once, however often the run is refreshed', async () => {
    makeJob()
    const remote = cinna.seed({ title: 'Reconcile payouts' })
    const run = jobRunsRepo.create({
      jobId: JOB_ID,
      userId: USER,
      type: 'cinna_task',
      cinnaTaskId: remote.id,
      cinnaShortCode: remote.short_code,
      status: 'running'
    })

    await jobService.refreshCinnaRun(USER, run.id)
    await jobService.refreshCinnaRun(USER, run.id)

    expect(taskRepo.list(USER, { includeArchived: true })).toHaveLength(1)
  })
})
