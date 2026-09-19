import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * The task page's Delete task, against a real database.
 *
 * A task a job run produced is deleted with that run and the run's chat — the
 * three rows Delete run used to remove from the job page — and any other task
 * is deleted alone, leaving its chat. The two halves of the first branch are
 * one transaction: a failure in either leaves both standing.
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
const { chatRepo } = await import('../db/chats')
const { taskRepo } = await import('../db/tasks')
const { taskService } = await import('./taskService')
const { installTaskRunnerHooks } = await import('./taskRunnerBridge')
const { jobService } = await import('./jobService')
const { activeRunsByChat } = await import('./runExecutionState')
const { chatConductorService } = await import('./chatConductorService')
const { sessionActivityHub } = await import('./sessionActivityHub')

const USER = '__default__'
const chatRemoved = vi.fn()

installTaskRunnerHooks(
  {
    answer: () => null,
    taskChanged: () => undefined,
    chatRemoved,
    profileRemoved: () => undefined
  } as never,
  'remove-with-job-run-test'
)

function jobRunWithTask(): { jobId: string; runId: string; chatId: string; taskId: string } {
  const job = jobsRepo.create(USER, { type: 'local', title: 'Nightly check', prompt: 'Check the invoices' })
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
  const task = taskService.create(USER, {
    title: 'Nightly check',
    goal: 'Check the invoices',
    chatId,
    jobId: job.id,
    jobRunId: runId
  })
  jobRunsRepo.setTaskId(runId, task.id)
  return { jobId: job.id, runId, chatId, taskId: task.id }
}

beforeEach(() => {
  holder.current = createTestDatabase()
  chatRemoved.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  activeRunsByChat.clear()
  holder.current?.close()
  holder.current = null
})

describe('taskService.removeWithJobRun', () => {
  it('deletes a job-run task together with its run and the run’s chat', () => {
    const { jobId, runId, chatId, taskId } = jobRunWithTask()

    const result = taskService.removeWithJobRun(USER, taskId)

    expect(result).toEqual({ jobRunId: runId, jobId, chatId, chatDeleted: true })
    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeInstanceOf(Date)
    expect(jobRunsRepo.getById(USER, runId)).toBeUndefined()
    expect(chatRepo.getOwned(USER, chatId)).toBeUndefined()
    // The same notification Delete run sends, so a waiting script lets go.
    expect(chatRemoved).toHaveBeenCalledWith(USER, chatId)
  })

  it('deletes any other task alone, and its chat stays', () => {
    const chat = chatRepo.create(USER)
    const task = taskService.create(USER, { title: 'Ask', goal: 'Answer me', chatId: chat.id })

    const result = taskService.removeWithJobRun(USER, task.id)

    expect(result).toEqual({ jobRunId: null, jobId: null, chatId: null, chatDeleted: false })
    expect(taskRepo.getById(USER, task.id)?.deletedAt).toBeInstanceOf(Date)
    expect(chatRepo.getOwned(USER, chat.id)).toBeTruthy()
    expect(chatRemoved).not.toHaveBeenCalled()
  })

  it('treats a task whose run is already gone as a plain task', () => {
    const { runId, chatId, taskId } = jobRunWithTask()
    jobRunsRepo.deleteWithChat(USER, runId)

    expect(taskService.removeWithJobRun(USER, taskId)).toEqual({
      jobRunId: null, jobId: null, chatId: null, chatDeleted: false
    })
    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeInstanceOf(Date)
    expect(chatRepo.getOwned(USER, chatId)).toBeUndefined()
  })

  it('does not take the chat of a run that belongs to another task', () => {
    const { runId, chatId } = jobRunWithTask()
    const stray = taskService.create(USER, { title: 'Stray', goal: 'Points at a run that is not its own', jobRunId: runId })

    expect(taskService.removeWithJobRun(USER, stray.id).jobRunId).toBeNull()
    expect(jobRunsRepo.getById(USER, runId)).toBeTruthy()
    expect(chatRepo.getOwned(USER, chatId)).toBeTruthy()
  })

  it('leaves the task in place when the run half fails', () => {
    const { runId, chatId, taskId } = jobRunWithTask()
    vi.spyOn(jobRunsRepo, 'deleteWithChat').mockImplementation(() => {
      throw new Error('disk I/O error')
    })

    expect(() => taskService.removeWithJobRun(USER, taskId)).toThrow('disk I/O error')

    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeNull()
    expect(jobRunsRepo.getById(USER, runId)).toBeTruthy()
    expect(chatRepo.getOwned(USER, chatId)).toBeTruthy()
    expect(chatRemoved).not.toHaveBeenCalled()
  })

  it('leaves the task in place when the run vanished before it could be deleted', () => {
    const { taskId } = jobRunWithTask()
    vi.spyOn(jobRunsRepo, 'deleteWithChat').mockReturnValue({ runDeleted: false, chatId: null, chatDeleted: false })

    expect(() => taskService.removeWithJobRun(USER, taskId)).toThrow()
    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeNull()
  })

  it('refuses a task that is already deleted', () => {
    const { taskId } = jobRunWithTask()
    taskService.remove(USER, taskId)
    expect(() => taskService.removeWithJobRun(USER, taskId)).toThrow('Task not found')
  })
})

/**
 * Both deletes hard-delete the run's chat, so both take chatService's guard
 * (no delete under a live turn) and permanentDelete's release of what memory
 * holds for the chat.
 */
describe('deleting a job run’s chat', () => {
  const BUSY = 'This run is still going. Stop it first; nothing was deleted.'

  function markStreaming(chatId: string): void {
    activeRunsByChat.set(chatId, { id: 'turn-1' } as never)
  }

  it('Delete task refuses while the run’s chat is streaming, and removes nothing', () => {
    const { runId, chatId, taskId } = jobRunWithTask()
    markStreaming(chatId)

    expect(() => taskService.removeWithJobRun(USER, taskId)).toThrow(BUSY)

    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeNull()
    expect(jobRunsRepo.getById(USER, runId)).toBeTruthy()
    expect(chatRepo.getOwned(USER, chatId)).toBeTruthy()
    expect(chatRemoved).not.toHaveBeenCalled()
  })

  it('Delete run refuses while its chat is streaming, and removes nothing', () => {
    const { runId, chatId, taskId } = jobRunWithTask()
    markStreaming(chatId)

    expect(() => jobService.deleteRun(USER, runId)).toThrow(BUSY)

    expect(taskRepo.getById(USER, taskId)?.deletedAt).toBeNull()
    expect(jobRunsRepo.getById(USER, runId)).toBeTruthy()
    expect(chatRepo.getOwned(USER, chatId)).toBeTruthy()
    expect(chatRemoved).not.toHaveBeenCalled()
  })

  it('Delete task releases the chat’s sessions, activity and conductor', () => {
    const { chatId, taskId } = jobRunWithTask()
    const conductorRemove = vi.spyOn(chatConductorService, 'remove').mockImplementation(() => undefined)
    const activityClear = vi.spyOn(sessionActivityHub, 'clear')

    taskService.removeWithJobRun(USER, taskId)

    expect(chatRemoved).toHaveBeenCalledWith(USER, chatId)
    expect(activityClear).toHaveBeenCalledWith(chatId)
    expect(conductorRemove).toHaveBeenCalledWith(USER, chatId)
  })

  it('Delete run releases the chat’s sessions, activity and conductor', () => {
    const { runId, chatId } = jobRunWithTask()
    const conductorRemove = vi.spyOn(chatConductorService, 'remove').mockImplementation(() => undefined)
    const activityClear = vi.spyOn(sessionActivityHub, 'clear')

    jobService.deleteRun(USER, runId)

    expect(chatRemoved).toHaveBeenCalledWith(USER, chatId)
    expect(activityClear).toHaveBeenCalledWith(chatId)
    expect(conductorRemove).toHaveBeenCalledWith(USER, chatId)
  })
})

/**
 * The confirm dialog's copy comes from here, so each answer is checked against
 * what `removeWithJobRun` then does to the same rows.
 */
describe('taskService.deletePreview', () => {
  it('a job-run task: its run and the run’s chat go, the job stays', () => {
    const { runId, chatId, taskId } = jobRunWithTask()
    expect(taskService.deletePreview(USER, taskId)).toEqual({
      deletesRun: true, chat: 'deleted_with_run', jobStays: true
    })
    taskService.removeWithJobRun(USER, taskId)
    expect(jobRunsRepo.getById(USER, runId)).toBeUndefined()
    expect(chatRepo.getOwned(USER, chatId)).toBeUndefined()
  })

  it('a job-run task whose job was soft-deleted: the run and chat still go, and no job is said to stay', () => {
    const { jobId, chatId, taskId } = jobRunWithTask()
    jobsRepo.softDelete(USER, jobId)
    expect(taskService.deletePreview(USER, taskId)).toEqual({
      deletesRun: true, chat: 'deleted_with_run', jobStays: false
    })
    taskService.removeWithJobRun(USER, taskId)
    expect(chatRepo.getOwned(USER, chatId)).toBeUndefined()
  })

  it('a job-run task whose chat is in the Trash: the chat is still deleted with the run', () => {
    const { chatId, taskId } = jobRunWithTask()
    chatRepo.softDelete(USER, chatId)
    expect(taskService.deletePreview(USER, taskId).chat).toBe('deleted_with_run')
    taskService.removeWithJobRun(USER, taskId)
    expect(chatRepo.getOwned(USER, chatId)).toBeUndefined()
  })

  it('a plain task with a live chat: the chat is kept', () => {
    const chat = chatRepo.create(USER)
    const task = taskService.create(USER, { title: 'Ask', goal: 'Answer me', chatId: chat.id })
    expect(taskService.deletePreview(USER, task.id)).toEqual({ deletesRun: false, chat: 'kept', jobStays: false })
    taskService.removeWithJobRun(USER, task.id)
    expect(chatRepo.getOwned(USER, chat.id)?.deletedAt).toBeNull()
  })

  it('a plain task whose chat is in the Trash: says so, and leaves it there', () => {
    const chat = chatRepo.create(USER)
    chatRepo.softDelete(USER, chat.id)
    const task = taskService.create(USER, { title: 'Ask', goal: 'Answer me', chatId: chat.id })
    expect(taskService.deletePreview(USER, task.id).chat).toBe('in_trash')
    taskService.removeWithJobRun(USER, task.id)
    expect(chatRepo.getOwned(USER, chat.id)?.deletedAt).toBeInstanceOf(Date)
  })

  it('a task whose run is already gone: no run, no chat, the job stays', () => {
    const { runId, taskId } = jobRunWithTask()
    jobRunsRepo.deleteWithChat(USER, runId)
    expect(taskService.deletePreview(USER, taskId)).toEqual({ deletesRun: false, chat: 'none', jobStays: true })
  })

  it('a task pointing at another task’s run: that run and chat are not claimed', () => {
    const { runId, chatId } = jobRunWithTask()
    const stray = taskService.create(USER, { title: 'Stray', goal: 'Not its run', chatId, jobRunId: runId })
    expect(taskService.deletePreview(USER, stray.id)).toEqual({ deletesRun: false, chat: 'kept', jobStays: false })
  })

  it('a task with no chat', () => {
    const task = taskService.create(USER, { title: 'Bare', goal: 'Nothing attached' })
    expect(taskService.deletePreview(USER, task.id)).toEqual({ deletesRun: false, chat: 'none', jobStays: false })
  })

  it('refuses a deleted task', () => {
    const { taskId } = jobRunWithTask()
    taskService.remove(USER, taskId)
    expect(() => taskService.deletePreview(USER, taskId)).toThrow('Task not found')
  })
})

/**
 * Whether a run's task is live, as the job page's rows read it: a run whose
 * task is gone — deleted here or on another device, runs do not sync — offers
 * Delete run itself and opens its chat instead of a task that is not there.
 */
describe('jobRunsRepo.listByJob taskLive', () => {
  it('is true while the task exists, and false once it is deleted', () => {
    const { jobId, runId, taskId } = jobRunWithTask()
    expect(jobRunsRepo.listByJob(USER, jobId).find((r) => r.id === runId)?.taskLive).toBe(true)
    taskService.remove(USER, taskId)
    expect(jobRunsRepo.listByJob(USER, jobId).find((r) => r.id === runId)?.taskLive).toBe(false)
  })

  it('is false for a run with no task, and for one naming a task that does not exist', () => {
    const { jobId, runId } = jobRunWithTask()
    jobRunsRepo.setTaskId(runId, 'no-such-task')
    expect(jobRunsRepo.listByJob(USER, jobId).find((r) => r.id === runId)?.taskLive).toBe(false)
    jobRunsRepo.setTaskId(runId, null as unknown as string)
    expect(jobRunsRepo.listByJob(USER, jobId).find((r) => r.id === runId)?.taskLive).toBe(false)
  })
})
