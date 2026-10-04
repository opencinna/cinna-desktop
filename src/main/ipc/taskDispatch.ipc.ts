import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { taskDispatchService } from '../services/taskDispatchService'
import { ipcHandle } from './_wrap'
import {
  TASK_DISPATCH_MAX_RUNS,
  isTaskDispatchMaxRuns,
  isTaskDispatchMode,
  type AgentDispatchState,
  type TaskDispatchRunResult,
  type TaskDispatchUpdateResult
} from '../../shared/taskDispatch'
import type { RunScope } from '../services/runExecutionService'

/**
 * `taskDispatch:*` — an agent's task queue: its run mode, its pause, and Run
 * next. Adapters only: the profile is resolved here, every decision is
 * `taskDispatchService`'s, and refusals come back as data (a thrown
 * `DomainError.code` does not survive the bridge; see `_wrap.ts`).
 */
function scope(): RunScope {
  return { profileUserId: getProfileScopeUserId(), settingsUserId: getSettingsScopeUserId() }
}

export function registerTaskDispatchHandlers(): void {
  /** Every dispatchable agent's queue (enabled local folder agents). */
  ipcHandle('taskDispatch:list', async (): Promise<AgentDispatchState[]> => {
    userActivation.requireActivated()
    return taskDispatchService.list(scope())
  })

  /** One agent's queue; null for an agent that cannot work one. */
  ipcHandle('taskDispatch:get', async (_event, agentId: unknown): Promise<AgentDispatchState | null> => {
    userActivation.requireActivated()
    return taskDispatchService.get(scope(), agentId)
  })

  /** `maxRuns` is N for `up_to` (2–8), checked here and again by the dispatcher; ignored for the other modes. */
  ipcHandle('taskDispatch:set-mode', async (_event, agentId: unknown, mode: unknown, maxRuns?: unknown): Promise<TaskDispatchUpdateResult> => {
    userActivation.requireActivated()
    if (!isTaskDispatchMode(mode)) return { ok: false, code: 'invalid_input', message: 'Choose Manual, One at a time or Up to N.' }
    if (mode !== 'up_to') return taskDispatchService.setMode(scope(), agentId, mode)
    if (!isTaskDispatchMaxRuns(maxRuns)) {
      return {
        ok: false,
        code: 'invalid_input',
        message: `Choose from ${TASK_DISPATCH_MAX_RUNS.min} to ${TASK_DISPATCH_MAX_RUNS.max} tasks at once.`
      }
    }
    return taskDispatchService.setMode(scope(), agentId, mode, maxRuns)
  })

  /** Clear the queue's pause. The flagged task stays where it is. */
  ipcHandle('taskDispatch:resume', async (_event, agentId: unknown): Promise<TaskDispatchUpdateResult> => {
    userActivation.requireActivated()
    return taskDispatchService.resume(scope(), agentId)
  })

  /** Run one task now, in any mode and while paused; `{ gate }` when its content needs approval first. */
  ipcHandle('taskDispatch:run-next', async (_event, agentId: unknown, taskId?: unknown): Promise<TaskDispatchRunResult> => {
    userActivation.requireActivated()
    return taskDispatchService.runNext(scope(), agentId, taskId)
  })
}
