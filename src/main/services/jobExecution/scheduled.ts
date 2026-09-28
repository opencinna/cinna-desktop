import { getDb, getRawSqlite } from '../../db/client'
import { jobsRepo, jobAgentRepo, jobMcpRepo, type JobRow } from '../../db/jobs'
import { taskRepo } from '../../db/tasks'
import { chatRunResultRepo } from '../../db/chatRunResults'
import { taskService } from '../taskService'
import { jobRuntimeDefinition } from '../../tasks/jobRuntimeDefinition'
import { createLogger } from '../../logger/logger'
import type { RunScope } from '../runExecutionService'
import { desktopJobExecutor } from './desktop'
import { canScheduleJob } from '../../../shared/localJobSchedules'
import { turnLock } from '../localAgents/turnLock'

const logger = createLogger('scheduled-job')

export interface PreparedScheduledJob {
  taskId: string
  runId: string
  chatId: string
  launch(): void
  interrupt(reason: string): void
}

/** The receipt is the restart marker for ordinary Jobs, which own no runner checkpoint. */
export function interruptScheduledOrdinaryJob(userId: string, taskId: string, chatId: string, runId: string, reason: string): void {
  const task = taskRepo.getById(userId, taskId)
  if (!task || task.deletedAt || ['completed', 'error', 'cancelled', 'archived'].includes(task.status)) return
  if (task.chatId !== chatId || task.jobRunId !== runId) throw new Error('This scheduled attempt no longer owns its task conversation.')
  getDb().transaction(() => {
    taskService.setStatus(userId, taskId, 'blocked', { errorMessage: reason })
    chatRunResultRepo.record(chatId, runId, 'needs_input')
  })
}

/**
 * Await only preflight, then call the returned factory inside the schedule's
 * claim transaction. Every route keeps its source Job and ordinary task
 * lifecycle; launch is the sole point at which a prompt may be dispatched.
 */
export async function prepareScheduledJob(scope: RunScope, job: JobRow, current: () => boolean): Promise<() => PreparedScheduledJob> {
  const assertScope = () => { if (!current()) throw new Error('The active profile changed before this scheduled job started.') }
  assertScope()
  if (!canScheduleJob(job.type) || job.userId !== scope.profileUserId || job.deletedAt) throw new Error('Only an available local Job can run on this device.')
  jobRuntimeDefinition(job)
  const snapshot = () => {
    const live = jobsRepo.getById(scope.profileUserId, job.id)
    if (!live || live.deletedAt || !canScheduleJob(live.type)) throw new Error('This scheduled Job is no longer available.')
    const fields = (value: JobRow) => JSON.stringify([value.userId, value.type, value.title, value.prompt, value.router, value.script, value.budget, value.modeId, value.syncDeps, value.cinnaPriority])
    if (fields(live) !== fields(job)) throw new Error('The scheduled Job changed before this attempt started.')
    return JSON.stringify([fields(live), jobAgentRepo.listAgentIds(job.id), jobMcpRepo.listProviderIds(job.id)])
  }
  const fingerprint = snapshot()
  const assertCurrent = () => {
    assertScope()
    if (snapshot() !== fingerprint) throw new Error('The scheduled Job dependencies changed before admission.')
  }
  if (job.router === 'coordinator') {
    const { prepareCoordinatorJob } = await import('../coordinatorJobService')
    assertCurrent()
    const prepare = await prepareCoordinatorJob(scope, job, current)
    assertCurrent()
    return () => { assertCurrent(); return prepare() }
  }
  if (job.router === 'script') {
    const { scriptRuntimeService } = await import('../scriptRuntimeService')
    assertCurrent()
    return () => {
      assertCurrent()
      const prepared = scriptRuntimeService.prepareJob(scope, job)
      return { ...prepared,
        launch() { assertScope(); prepared.launch() },
        interrupt(reason) { scriptRuntimeService.interruptPrepared(scope.profileUserId, prepared.taskId, reason) }
      }
    }
  }
  const [{ runExecutionService }, { inboxService }] = await Promise.all([import('../runExecutionService'), import('../inboxService')])
  assertCurrent()
  return () => {
    assertCurrent()
    const prepared = desktopJobExecutor.prepareRendererTurn!(scope, job)
    let launched = false
    const interrupt = (reason: string) => interruptScheduledOrdinaryJob(scope.profileUserId, prepared.taskId, prepared.chatId, prepared.runId, reason)
    return { taskId: prepared.taskId, runId: prepared.runId, chatId: prepared.chatId, interrupt,
      launch() {
        assertScope()
        if (getRawSqlite().inTransaction) throw new Error('Commit the job admission before launching it.')
        if (launched) throw new Error('This prepared job was already launched.')
        const task = taskRepo.getById(scope.profileUserId, prepared.taskId)
        if (!task || task.deletedAt || task.status !== 'in_progress') throw new Error('This prepared job is no longer awaiting launch.')
        // A due occurrence is never skipped for earlier work, but an agent still
        // in a turn would refuse this one as a failure. Throwing here takes the
        // caller's interrupt path instead: the task is blocked with this reason
        // and the occurrence reads "Needs review", for the user to re-run or dismiss.
        if (prepared.agentId && turnLock.isLocked(prepared.agentId)) {
          throw new Error('The agent was still busy with an earlier turn, so this scheduled run did not start. Re-run it from the task, or dismiss it.')
        }
        const handle = runExecutionService.start(scope, { chatId: prepared.chatId, content: prepared.prompt,
          ...(prepared.agentId ? { addressedAgentId: prepared.agentId } : {}) }, {
          preserveOnRefusal: true,
          observe: (ctx, event) => inboxService.recordRunEvent(ctx, event),
          onAccepted: () => assertScope()
        })
        launched = true
        // The main run service owns terminal results and Inbox gates. An
        // acceptance refusal is already admitted work and must remain visible.
        void handle.accepted.catch((error: unknown) => {
          try { interrupt(error instanceof Error ? error.message : String(error)) }
          catch { logger.warn('could not mark an unlaunched scheduled job interrupted', { taskId: prepared.taskId }) }
        })
      }
    }
  }
}
