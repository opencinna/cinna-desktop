import type { InboxAnswerResult } from '../../shared/inbox'
import type { RequestResolution } from '../../shared/localAgentRequests'

/** Inbox/authority notifications stay independent of runner implementation imports. */
export interface TaskRunnerHooks {
  answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null
  taskChanged(userId: string, taskId: string): void
  chatRemoved(userId: string, chatId: string): void
  profileRemoved(userId: string): void
}
let hooks: TaskRunnerHooks | undefined
export function installTaskRunnerHooks(value: TaskRunnerHooks): void { hooks = value }
export const taskRunnerBridge = {
  answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null {
    return hooks?.answer(userId, requestId, resolution) ?? null
  },
  taskChanged(userId: string, taskId: string): void { hooks?.taskChanged(userId, taskId) },
  chatRemoved(userId: string, chatId: string): void { hooks?.chatRemoved(userId, chatId) },
  profileRemoved(userId: string): void { hooks?.profileRemoved(userId) }
}
