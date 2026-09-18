import type { TaskInputRequestRow } from '../db/taskInputRequests'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { chatRepo } from '../db/chats'
import { taskService } from './taskService'
import { runExecutionService, type RunHandle, type RunScope } from './runExecutionService'
import { inboxService } from './inboxService'
import { createLogger } from '../logger/logger'
import { activeRunsByChat } from './runExecutionState'
import { REQUEST_PARK_TIMEOUT_MS } from '../../shared/localAgentRequests'

const logger = createLogger('nested-continuation')

/** Persisted child invocation identity, retained across app restarts and repeated asks. */
export function nestedToolCallId(row: TaskInputRequestRow): string | null {
  const prefix = row.rootRunId && `${row.rootRunId}:`
  return prefix && row.invocationId?.startsWith(prefix) ? row.invocationId.slice(prefix.length) || null : null
}

/** Called only after Inbox acceptance. The completed call returns as a new, attributed prompt. */
export async function completeNestedContinuation(
  scope: RunScope,
  row: TaskInputRequestRow,
  handle: RunHandle,
  toolCallId: string
): Promise<void> {
  try {
    const outcome = await handle.completed
    if (outcome.state === 'canceled' || outcome.state === 'needs_input' || outcome.inputRequestReadError) return
    if (taskInputRequestRepo.listOpenForChat(row.chatId).some((request) => request.agentId === row.agentId && request.resume === 'next_message')) return
    const deadline = Date.now() + REQUEST_PARK_TIMEOUT_MS + 20 * 60_000
    while (true) {
      const chat = chatRepo.getOwned(scope.profileUserId, row.chatId)
      if (!chat || chat.deletedAt || chat.router !== 'coordinator') return
      const task = taskService.getById(scope.profileUserId, row.taskId)
      if (!task.runsHere || task.executor !== 'desktop' || !['blocked', 'in_progress'].includes(task.status)) return
      if (!runExecutionService.isRunning(row.chatId)) break
      if (Date.now() >= deadline) throw new Error('The conversation stayed busy before the specialist result could return.')
      const active = activeRunsByChat.get(row.chatId)
      if (active) await active.completed
      else await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); timer.unref?.() })
    }
    const content = [
      `The specialist continuation for tool call ${JSON.stringify(toolCallId)} (agent ${JSON.stringify(row.agentId)}) has finished after the human answered its Inbox question.`,
      'This completes that earlier tool call. Use the result below to continue the original request.',
      outcome.error ? `Specialist error: ${outcome.error.message}` : outcome.text
    ].join('\n\n')
    const followUp = runExecutionService.start(scope, { chatId: row.chatId, content }, {
      inputOrigin: 'specialist',
      observe: (ctx, event) => inboxService.recordRunEvent(ctx, event),
      onAccepted: (ctx) => inboxService.resumeChat(ctx, content)
    })
    await followUp.accepted
  } catch (error) {
    logger.warn('specialist completion could not return to its conductor', { chatId: row.chatId, toolCallId, error: String(error) })
  }
}
