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

  it.each(['job cancel', 'task cancel', 'task archive'] as const)(
    '%s settles both records and expires an idle next-message ask', async (action) => {
      const { taskInputRequestRepo } = await import('../db/taskInputRequests')
      const { chatId, taskId, runId } = startedRunWithTask()
      taskInputRequestRepo.open({
        requestId: 'idle-ask', taskId, chatId, agentId: 'remote-agent', resume: 'next_message',
        request: { kind: 'question', questions: [{ question: 'Which branch?', options: [], multiSelect: false }] }
      })
      taskService.applyRunState(USER, taskId, 'needs_input')
      if (action === 'job cancel') jobService.setRunStatus(USER, runId, 'cancelled')
      else taskService.setStatus(USER, taskId, action === 'task archive' ? 'archived' : 'cancelled')
      expect(taskService.getById(USER, taskId).status).toBe(action === 'task archive' ? 'archived' : 'cancelled')
      expect(jobRunsRepo.getById(USER, runId)?.status).toBe('cancelled')
      expect(taskInputRequestRepo.listOpenForChat(chatId)).toEqual([])
      // A delayed completion from the old turn cannot reopen or complete it.
      jobService.reportRunCompletion(chatId, 'succeeded')
      expect(jobRunsRepo.getById(USER, runId)?.status).toBe('cancelled')
    }
  )

  it('does not let a late explicit job cancel rewrite a successful attempt', () => {
    const { chatId, runId, taskId } = startedRunWithTask()
    jobService.reportRunCompletion(chatId, 'succeeded')
    jobService.setRunStatus(USER, runId, 'cancelled')
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('succeeded')
    expect(taskService.getById(USER, taskId).status).toBe('completed')
  })

  it('keeps a next-message job running until its answer resumes and completes the same task', async () => {
    const { taskInputRequestRepo } = await import('../db/taskInputRequests')
    const { chatId, taskId, runId } = startedRunWithTask()
    taskInputRequestRepo.open({
      requestId: 'next-one', taskId, chatId, agentId: 'remote-agent', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Which branch?', options: [], multiSelect: false }] }
    })
    taskService.applyRunState(USER, taskId, 'needs_input')
    jobService.reportRunCompletion(chatId, 'succeeded')
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('running')
    expect(taskService.getById(USER, taskId).status).toBe('blocked')
    taskInputRequestRepo.settle('next-one', 'answered', { kind: 'question', answers: [['main']] })
    taskService.applyRunState(USER, taskId, 'working')
    jobService.reportRunCompletion(chatId, 'succeeded')
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('succeeded')
    expect(taskService.getById(USER, taskId).status).toBe('completed')
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

/**
 * *Re-run from the last message* on a task whose job run already ended — the
 * boot recovery case, where a quit left the run `failed`, the task `error` and
 * the schedule occurrence `failed`. The re-run reopens the run through
 * `taskService.reopenForRerun`, so its outcome closes run, task and occurrence;
 * without that the task stayed `in_progress` for ever.
 */
describe('re-running a job-owned task', () => {
  async function scheduledRun(): Promise<{ runId: string; chatId: string; taskId: string; bindingId: string; occurrenceId: string }> {
    const { localScheduleRepo } = await import('../db/localSchedules')
    const { runId, chatId, jobId } = startedRun()
    const task = taskService.create(USER, { title: 'Nightly check', goal: 'Check the invoices', chatId, jobId, jobRunId: runId })
    jobRunsRepo.setTaskId(runId, task.id)
    taskService.start(USER, task.id, { chatId })
    const definition = { executionType: 'job' as const, jobId, jobTitle: 'Nightly check', jobRevision: 'r', prompt: 'Check the invoices', name: 'Nightly', cron: '0 8 * * *', timezone: 'UTC' }
    localScheduleRepo.save({ id: 'binding-1', userId: USER, manifestId: `job:${jobId}`, name: 'Nightly', definition, revision: 'rev',
      jobId, jobFingerprint: 'r', jobIds: [jobId], enabled: true, reason: null, watermark: 0, nextDueAt: null, enabledSince: 0,
      lastAttemptAt: null, lastCompletedAt: null, cursorVersion: 1, editorMetadata: null })
    localScheduleRepo.insertOccurrence({ id: 'occurrence-1', bindingId: 'binding-1', userId: USER, civilKey: '2026-09-14T08:00', utcMinute: 1,
      definition, revision: 'rev', status: 'dispatched', taskId: task.id, runId, chatId, reason: null, scheduledFor: 60000, observedAt: 60000,
      coveredThrough: 60000, startedAt: 60000, finishedAt: null, triggerKind: 'scheduled', resultKind: 'agent_started', commandOutcome: null })
    return { runId, chatId, taskId: task.id, bindingId: 'binding-1', occurrenceId: 'occurrence-1' }
  }
  async function occurrence(id: string) {
    const { localScheduleRepo } = await import('../db/localSchedules')
    return localScheduleRepo.occurrences(USER, 'binding-1').find((row) => row.id === id)
  }

  it('settles the occurrence from the run outcome', async () => {
    const { chatId, occurrenceId, bindingId } = await scheduledRun()
    jobService.reportRunCompletion(chatId, 'failed', 'The app quit during this turn.')
    expect(await occurrence(occurrenceId)).toMatchObject({ status: 'failed', reason: 'The app quit during this turn.' })
    const { localScheduleRepo } = await import('../db/localSchedules')
    expect(localScheduleRepo.get(USER, bindingId)?.lastCompletedAt).toEqual((await occurrence(occurrenceId))?.finishedAt)
  })

  it('reopens a failed run, and a successful re-run completes run, task and occurrence', async () => {
    const { chatId, runId, taskId, occurrenceId, bindingId } = await scheduledRun()
    jobService.reportRunCompletion(chatId, 'failed', 'The app quit during this turn.')
    expect(taskService.getById(USER, taskId).status).toBe('error')

    expect(taskService.reopenForRerun(USER, taskId).status).toBe('in_progress')
    expect(jobRunsRepo.getById(USER, runId)).toMatchObject({ status: 'running', errorMessage: null, finishedAt: null })
    // Not reopened until the re-run's outcome lands.
    expect((await occurrence(occurrenceId))?.status).toBe('failed')

    jobService.reportRunCompletion(chatId, 'succeeded')
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('succeeded')
    expect(taskService.getById(USER, taskId).status).toBe('completed')
    const settled = await occurrence(occurrenceId)
    expect(settled).toMatchObject({ status: 'completed', reason: null })
    const { localScheduleRepo } = await import('../db/localSchedules')
    expect(localScheduleRepo.get(USER, bindingId)?.lastCompletedAt).toBe(settled?.finishedAt)
  })

  it('a failed re-run fails run, task and occurrence again', async () => {
    const { chatId, runId, taskId, occurrenceId } = await scheduledRun()
    jobService.reportRunCompletion(chatId, 'failed', 'The app quit during this turn.')
    taskService.reopenForRerun(USER, taskId)
    jobService.reportRunCompletion(chatId, 'failed', 'Invalid API key')
    expect(jobRunsRepo.getById(USER, runId)).toMatchObject({ status: 'failed', errorMessage: 'Invalid API key' })
    expect(taskService.getById(USER, taskId)).toMatchObject({ status: 'error', errorMessage: 'Invalid API key' })
    expect(await occurrence(occurrenceId)).toMatchObject({ status: 'failed', reason: 'Invalid API key' })
  })

  it('reopens a task with no job run exactly as setStatus did', () => {
    const task = taskService.create(USER, { title: 'Hand-made', goal: 'Do it' })
    taskService.start(USER, task.id)
    taskService.setStatus(USER, task.id, 'error', { errorMessage: 'Broke' })
    const reopened = taskService.reopenForRerun(USER, task.id)
    expect(reopened).toMatchObject({ status: 'in_progress', errorMessage: null })
  })

  it('refuses an illegal step the way setStatus does, and writes nothing', () => {
    const task = taskService.create(USER, { title: 'Hand-made', goal: 'Do it' })
    taskService.start(USER, task.id)
    taskService.setStatus(USER, task.id, 'archived')
    expect(() => taskService.reopenForRerun(USER, task.id)).toThrow('cannot go from archived to in_progress')
    expect(taskService.getById(USER, task.id).status).toBe('archived')
  })

  it.each(['task runtime', 'script runtime'] as const)('refuses a task a %s owns, and reopens nothing', async (kind) => {
    const { chatId, runId, taskId } = await scheduledRun()
    jobService.reportRunCompletion(chatId, 'failed', 'The app quit during this turn.')
    if (kind === 'task runtime') {
      const { taskRuntimeRepo } = await import('../db/taskRuntimes')
      taskRuntimeRepo.save(USER, taskId, { state: 'running', chatId } as never)
    } else {
      const { scriptRuntimeRepo } = await import('../db/scriptRuntimes')
      scriptRuntimeRepo.save(USER, taskId, { steps: {} } as never)
    }

    expect(() => taskService.reopenForRerun(USER, taskId)).toThrow('run by its runtime')
    expect(taskService.getById(USER, taskId).status).toBe('error')
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('failed')
  })

  it.each(['task', 'chat'] as const)('does not reopen a run whose %s does not match the task', (mismatch) => {
    const { runId, chatId, jobId } = startedRun()
    const other = startedRun()
    const task = taskService.create(USER, { title: 'Nightly check', goal: 'Check the invoices',
      chatId: mismatch === 'chat' ? other.chatId : chatId, jobId, jobRunId: runId })
    jobRunsRepo.setTaskId(runId, mismatch === 'task' ? 'another-task' : task.id)
    taskService.start(USER, task.id, { chatId: mismatch === 'chat' ? other.chatId : chatId })
    jobRunsRepo.updateStatus(runId, 'failed', { errorMessage: 'Earlier failure' })
    taskService.setStatus(USER, task.id, 'error', { errorMessage: 'Earlier failure' })

    expect(taskService.reopenForRerun(USER, task.id).status).toBe('in_progress')
    expect(jobRunsRepo.getById(USER, runId)).toMatchObject({ status: 'failed', errorMessage: 'Earlier failure' })
  })
})
