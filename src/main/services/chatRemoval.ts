import { taskRunnerBridge } from './taskRunnerBridge'
import { chatConductorService } from './chatConductorService'
import { taskRunnersByChat } from './taskRunnerState'
import { activeRunsByChat } from './runExecutionState'
import { sessionActivityHub } from './sessionActivityHub'
import { forgetChatSessions } from './chatSessionRelease'

/**
 * The turn or autonomous runner currently working in a chat, if any. A chat
 * with one must not be deleted: the turn would keep writing into rows that are
 * gone. Shared by every path that removes a chat — `chatService.delete`, and
 * the job-run deletes (`jobService.deleteRun`, `taskService.removeWithJobRun`)
 * that hard-delete a run's chat.
 *
 * Lives here rather than in `chatService` so the task and job services can use
 * it without importing chatService's agent and routing graph.
 */
export function activeChatRunId(chatId: string): string | null {
  const runner = taskRunnersByChat.get(chatId)
  return activeRunsByChat.get(chatId)?.id ?? (runner?.working ? runner.id : null)
}

/**
 * Everything held in memory for a chat, released once its row is hard-deleted:
 * a waiting script's gates, the chat's agent sessions and activity, and its
 * conductor runtime. Call after the delete has committed, never before.
 */
export function chatHardDeleted(userId: string, chatId: string): void {
  taskRunnerBridge.chatRemoved(userId, chatId)
  forgetChatSessions(chatId)
  sessionActivityHub.clear(chatId)
  chatConductorService.remove(userId, chatId)
}
