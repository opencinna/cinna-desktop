import type { InboxAnswerResult } from '../../shared/inbox'
import type { RequestResolution } from '../../shared/localAgentRequests'

/** Inbox/authority notifications stay independent of runner implementation imports. */
export interface TaskRunnerHooks {
  answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null
  taskChanged(userId: string, taskId: string): void
  chatRemoved(userId: string, chatId: string): void
  profileRemoved(userId: string): void
}
const hooks = new Map<string, TaskRunnerHooks>()
export function installTaskRunnerHooks(value: TaskRunnerHooks, name = 'coordinator'): void { hooks.set(name, value) }
export const taskRunnerBridge = {
  answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null {
    for (const hook of hooks.values()) {
      const result = hook.answer(userId, requestId, resolution)
      if (result !== null) return result
    }
    return null
  },
  taskChanged(userId: string, taskId: string): void { hooks.forEach((hook) => hook.taskChanged(userId, taskId)) },
  chatRemoved(userId: string, chatId: string): void { hooks.forEach((hook) => hook.chatRemoved(userId, chatId)) },
  profileRemoved(userId: string): void { hooks.forEach((hook) => hook.profileRemoved(userId)) }
}
