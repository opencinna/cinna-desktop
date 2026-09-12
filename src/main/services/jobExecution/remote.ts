import { getDb } from '../../db/client'
import { jobsRepo, jobRunsRepo } from '../../db/jobs'
import { jobRunStatusForTask } from '../../../shared/taskStatus'
import { parseTaskPriority, type TaskDto } from '../../../shared/tasks'
import { JobError, TaskError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { jobRuntimeDefinition } from '../../tasks/jobRuntimeDefinition'
import { taskService } from '../taskService'
import { taskSyncService } from '../taskSyncService'
import type { JobExecutor } from './contract'
const logger = createLogger('job')
export const remoteJobExecutor: JobExecutor = {
  async execute(scope, job) {
    return { type: 'cinna_task', disposition: 'accepted', ...await remoteJobExecutor.executeRemote!(scope, job) }
  },
  async executeRemote(scope, job) {
    const userId = scope.profileUserId
    const jobId = job.id
    if (job.router != null || job.script != null || job.budget != null) jobRuntimeDefinition(job)
    if (!job.cinnaAgentId) {
      throw new JobError('missing_dependency', 'Cinna agent is required to run this job')
    }
    const isCurrent = taskSyncService.captureConnection(userId)
    // **Before the task exists.** The hand-over checks this too, and by then the
    // task has been created — so a profile that is not connected to a service
    // minted a task and soft-deleted it on *every* press of Run. A soft delete
    // is not a rollback: the row survives for ever and travels to the user's
    // other devices as an ordinary upsert carrying `deleted: true`. The task
    // still cannot be created after the adapter call (`adapter.create` is handed
    // its id as `external_ref`, which is what makes a retried create
    // idempotent), so the check moves rather than the creation.
    if (!(await taskSyncService.preferredAdapterId(userId))) {
      throw new JobError(
        'incomplete_setup',
        "This job runs on a service, and this profile isn't connected to one."
      )
    }

    const fresh = jobsRepo.getById(userId, jobId)
    const fields = ['type', 'title', 'prompt', 'cinnaAgentId', 'cinnaPriority', 'router', 'script', 'budget'] as const
    if (!isCurrent() || !fresh || fresh.deletedAt || fields.some((field) => JSON.stringify(fresh[field]) !== JSON.stringify(job[field]))) {
      throw new JobError('invalid_input', 'The job or connection changed. Review the job before running it again.')
    }

    const task = taskService.create(userId, {
      title: job.title,
      goal: job.prompt,
      // The service routes the work; the desktop's own routers describe a chat,
      // and this task has none.
      router: 'direct',
      origin: 'local',
      executor: 'desktop',
      // **An id in the space its kind names.** `remote_agent` is an agent that
      // exists on the service and nowhere here, which is exactly what a job's
      // configured agent is — there is no local `agents` row to point at.
      assigneeAgentId: job.cinnaAgentId,
      assigneeName: null,
      assigneeKind: 'remote_agent',
      priority: parseTaskPriority(job.cinnaPriority),
      jobId
    })

    let handed: TaskDto
    try {
      handed = await taskSyncService.handOff(userId, task.id)
    } catch (err) {
      // Soft-deleted rather than left: a task nothing picked up is not a task,
      // and leaving it would put a permanently `new` row on the user's other
      // devices for a run that never happened.
      //
      // **The cleanup may not replace the failure.** It is a second write on a
      // path that has already failed once, and a throw from it would surface
      // instead of the hand-over's own error — so the user would read "Task not
      // found" where the truth was "that service refused the work". The
      // original is what the surface needs; an orphan is what the log gets.
      // **Not for a hand-over that succeeded.** `handed_over` means the service
      // took the work and only the local record of it was lost, so there is
      // nothing to clean up and an agent is running right now. Deleting here
      // would be the app arguing with a row a peer has already removed.
      if (err instanceof TaskError && (err.code === 'handed_over' || err.code === 'handoff_uncertain')) throw err
      try {
        taskService.remove(userId, task.id)
      } catch (cleanupErr) {
        logger.warn('a refused hand-over left its task behind', {
          jobId,
          taskId: task.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        })
      }
      throw err
    }

    let run: ReturnType<typeof jobRunsRepo.create>
    try {
      run = getDb().transaction(() => {
        const run = jobRunsRepo.create({
          jobId, userId, type: 'cinna_task', taskId: task.id,
          cinnaTaskId: handed.remote?.id ?? null,
          cinnaShortCode: handed.remote?.key ?? null,
          status: jobRunStatusForTask(handed.status)
        })
        taskService.linkJobRun(userId, task.id, run.id)
        return run
      })
    } catch (error) {
      logger.warn('accepted remote job could not record its run', { jobId, taskId: task.id, error: String(error) })
      throw new TaskError('handed_over', 'The service accepted this work, but its Job run could not be saved. Open Tasks to find it; do not run the Job again.')
    }

    logger.info('job executed (handed to a service)', {
      jobId,
      runId: run.id,
      taskId: task.id,
      remoteId: handed.remote?.id,
      shortCode: handed.remote?.key
    })

    return {
      runId: run.id,
      taskId: task.id,
      cinnaTaskId: handed.remote?.id ?? '',
      cinnaShortCode: handed.remote?.key ?? null
    }
  }
}
