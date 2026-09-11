import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * How a job run ends when the user presses **Stop**, against a real database.
 *
 * `reportRunCompletion` is the only hook the streaming services have for
 * finalizing a run, and it took `'succeeded' | 'failed'` — neither of which is
 * what a stop is. So `chatStreamingService`'s abort branch reported nothing and
 * returned, and the run stayed `running`.
 *
 * That is not cosmetic and it does not clear itself. Nothing reaps a stale run:
 * `setRunStatus` is reachable only from the explicit run-cancel action in
 * `job.ipc.ts`, which is a different gesture from stopping the chat. And
 * `countInProgressByJob` — the sidebar's "is this job running?" indicator —
 * counts `pending` and `running`, so a job the user stopped advertised itself
 * as busy for the life of the app. **That count is the assertion that matters
 * here**; the status column alone would pass while the badge stayed lit.
 *
 * The OpenAI adapter is why this surfaced now. It used to swallow its abort and
 * resolve with the partial text, so a cancelled OpenAI turn left the `try`
 * normally and was recorded `succeeded` — wrong, but terminal. Anthropic and
 * Gemini always rejected and always left the run hanging; making the three
 * agree turned a quiet inconsistency into one shared bug, which is how it got
 * looked at.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

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
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { jobService } = await import('./jobService')
const { taskRepo } = await import('../db/tasks')
const { taskService } = await import('./taskService')

const USER = '__default__'

/**
 * A job with one running run bound to a chat, built through the same
 * transactional call `executeLocal` uses. Not hand-assembled: the run's
 * `localChatId` is a foreign key onto a real chat row, and that link is exactly
 * what `reportRunCompletion` looks the run up by.
 */
function startedRun(): { jobId: string; runId: string; chatId: string } {
  const job = jobsRepo.create(USER, {
    type: 'local',
    title: 'Nightly check',
    prompt: 'Check the invoices'
  })
  const { chatId, runId } = jobRunsRepo.createLocalChatAndRun({
    userId: USER,
    jobId: job.id,
    title: 'Nightly check',
    prompt: 'Check the invoices',
    rootAgentId: null,
    router: 'direct',
    modeId: null,
    providerId: null,
    modelId: null,
    onDemandAgentIds: [],
    onDemandMcpIds: []
  })
  return { jobId: job.id, runId, chatId }
}

beforeEach(() => {
  holder.current = createTestDatabase()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('jobService.reportRunCompletion', () => {
  it('finalizes a stopped run as cancelled, and stops the sidebar counting it', () => {
    const { jobId, runId, chatId } = startedRun()
    expect(jobRunsRepo.countInProgressByJob(USER).get(jobId)).toBe(1)

    jobService.reportRunCompletion(chatId, 'cancelled')

    const row = jobRunsRepo.listByJob(USER, jobId).find((r) => r.id === runId)
    expect(row?.status).toBe('cancelled')
    expect(row?.finishedAt).not.toBeNull()
    // The half a status assertion alone would miss: a run left at `running` is
    // what keeps the job's "currently running" badge lit for ever.
    expect(jobRunsRepo.countInProgressByJob(USER).get(jobId)).toBeUndefined()
  })

  it('records no error message for a stop, because a stop is not a failure', () => {
    const { jobId, runId, chatId } = startedRun()
    jobService.reportRunCompletion(chatId, 'cancelled')
    const row = jobRunsRepo.listByJob(USER, jobId).find((r) => r.id === runId)
    expect(row?.errorMessage).toBeNull()
  })

  it('still finalizes success and failure the way it always did', () => {
    const { jobId, runId, chatId } = startedRun()
    jobService.reportRunCompletion(chatId, 'failed', 'Invalid OpenAI API key')
    const row = jobRunsRepo.listByJob(USER, jobId).find((r) => r.id === runId)
    expect(row?.status).toBe('failed')
    expect(row?.errorMessage).toBe('Invalid OpenAI API key')
  })

  it('leaves a run that already ended alone, so a late stop cannot rewrite it', () => {
    // The abort branch can be reached after the stream already finished — the
    // user presses Stop as the last delta lands — and overwriting a `succeeded`
    // run with `cancelled` would lose the outcome the job actually had.
    const { jobId, runId, chatId } = startedRun()
    jobService.reportRunCompletion(chatId, 'succeeded')
    jobService.reportRunCompletion(chatId, 'cancelled')
    const row = jobRunsRepo.listByJob(USER, jobId).find((r) => r.id === runId)
    expect(row?.status).toBe('succeeded')
  })
})

/**
 * The run row is the record of the job's *attempt*; the task is the record of
 * the **work**, and it outlives the chat. A run that ends has to say so in both
 * places, or the Jobs view and the task list disagree about the same fact.
 *
 * The status does not come from a switch here — it goes through
 * `taskService.applyRunState`, so a job run and an agent turn report a task the
 * same way, and so the `new → completed` jump a run that finishes instantly
 * would attempt is walked rather than refused.
 */
describe('a finished run finishes its task', () => {
  /** A started run with a task attached, the way `executeLocal` leaves one. */
  function startedRunWithTask(): { runId: string; chatId: string; taskId: string } {
    const { runId, chatId, jobId } = startedRun()
    const task = taskService.create(USER, {
      title: 'Nightly check',
      goal: 'Check the invoices',
      chatId,
      jobId,
      jobRunId: runId
    })
    jobRunsRepo.setTaskId(runId, task.id)
    taskService.start(USER, task.id, { chatId })
    return { runId, chatId, taskId: task.id }
  }

  it('completes the task when the run succeeds', () => {
    const { chatId, taskId } = startedRunWithTask()
    jobService.reportRunCompletion(chatId, 'succeeded')
    const task = taskRepo.getById(USER, taskId)
    expect(task?.status).toBe('completed')
    expect(task?.finishedAt).not.toBeNull()
  })

  it('errors the task and keeps the reason when the run fails', () => {
    const { chatId, taskId } = startedRunWithTask()
    jobService.reportRunCompletion(chatId, 'failed', 'Invalid OpenAI API key')
    const task = taskRepo.getById(USER, taskId)
    expect(task?.status).toBe('error')
    expect(task?.errorMessage).toBe('Invalid OpenAI API key')
  })

  it('cancels the task when the user presses Stop', () => {
    const { chatId, taskId } = startedRunWithTask()
    jobService.reportRunCompletion(chatId, 'cancelled')
    const task = taskRepo.getById(USER, taskId)
    expect(task?.status).toBe('cancelled')
    // A stop is not a failure, in both places.
    expect(task?.errorMessage).toBeNull()
  })

  it('finalizes the run even when the task write cannot happen', () => {
    // Best-effort on purpose. A run that has genuinely finished must be
    // recorded as finished whatever happens to the task, or the sidebar counts
    // it as busy for the life of the app — trading a visible wrong status for
    // an invisible one.
    const { runId, chatId, taskId } = startedRunWithTask()
    taskService.remove(USER, taskId)

    expect(() => jobService.reportRunCompletion(chatId, 'succeeded')).not.toThrow()
    const row = jobRunsRepo.getById(USER, runId)
    expect(row?.status).toBe('succeeded')
  })

  it('still finalizes a run from before tasks existed', () => {
    // `job_runs.task_id` is nullable for exactly these rows.
    const { runId, chatId } = startedRun()
    expect(jobRunsRepo.getById(USER, runId)?.taskId).toBeNull()
    jobService.reportRunCompletion(chatId, 'succeeded')
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('succeeded')
  })

  it('leaves the task alone when a late stop cannot rewrite the run', () => {
    const { chatId, taskId } = startedRunWithTask()
    jobService.reportRunCompletion(chatId, 'succeeded')
    jobService.reportRunCompletion(chatId, 'cancelled')
    expect(taskRepo.getById(USER, taskId)?.status).toBe('completed')
  })
})
