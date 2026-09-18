import { taskService } from './taskService'
import { handingOffTasks, taskOperationKey } from './taskOperationState'
import { taskHandoffRepo } from '../db/taskHandoffs'
import { taskFileService } from './taskFileService'
import { chatRepo, type ChatRow } from '../db/chats'
import { messageRepo } from '../db/messages'
import { chatMcpRepo } from '../db/chatMcp'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { agentOverrideRepo } from '../db/agents'
import { agentService } from './agentService'
import { driverFor } from '../agents/drivers'
import { runExecutionService, type RunOutcome, type RunScope } from './runExecutionService'
import { inboxService } from './inboxService'
import { resolveTaskModelConfig, type TaskModelConfig } from './taskModelConfig'
import { getProfileScopeUserId } from '../auth/scope'
import { userActivation } from '../auth/activation'
import { canTransition } from '../../shared/taskStatus'
import { readinessBlocksTurn } from '../../shared/agentDrivers'
import { TaskError } from '../errors'
import type { DesktopTaskTarget, TaskAssignee, TaskDto, TaskStartResult } from '../../shared/tasks'

const starting = new Set<string>()

export function taskContinuationPrompt(task: Pick<TaskDto, 'goal' | 'description' | 'handoffNote'>): string {
  const sections = ['Continue this task.', `Goal:\n${task.goal}`]
  if (task.description?.trim() && task.description.trim() !== task.goal.trim()) {
    sections.push(`Current description:\n${task.description}`)
  }
  if (task.handoffNote?.trim()) sections.push(`Handoff note:\n${task.handoffNote}`)
  return sections.join('\n\n')
}

/**
 * Options no IPC payload carries — a caller *inside* main handing over state it
 * created for this very start.
 *
 * Deliberately not on `DesktopTaskTarget` and not on the `task:start` payload:
 * a renderer that could name a chat to reuse could point a task at somebody
 * else's conversation, and every guard below would then be checking the wrong
 * thing.
 */
export interface TaskStartOptions {
  /**
   * A chat created ahead of the start and not yet used — today, the chat a
   * handover gate had to create so its Inbox row could have a `chat_id`
   * (`handoverService`). It is adopted instead of creating a second one, so a
   * gate that was answered Run does not leave an empty chat behind.
   *
   * Verified below before it is touched: owned by this profile, bound to the
   * same agent by `direct` routing, no messages, not running, and the task
   * still has no chat of its own.
   */
  reuseChatId?: string
}

/**
 * Take over a chat somebody else created for this start, or refuse.
 *
 * Every condition is one the caller could otherwise get wrong in a way the
 * user would see: a chat with messages would replay a stranger's conversation
 * as this task's first turn; a chat bound to a different agent would send the
 * prompt to the wrong engine; a running one would collide with a live turn; and
 * a task that already has a chat does not need a second.
 */
function adoptChat(scope: RunScope, task: TaskDto, agentId: string | null, chatId: string): ChatRow {
  const refuse = (reason: string): never => {
    throw new TaskError('invalid_input', reason)
  }
  if (task.chatId) refuse('This task already has a conversation. Continue it there.')
  const chat = chatRepo.getOwned(scope.profileUserId, chatId)
  if (!chat || chat.deletedAt) return refuse('That conversation is no longer available.')
  if (chat.router !== 'direct' || chat.agentId !== agentId) {
    refuse('That conversation belongs to another agent.')
  }
  if (messageRepo.lastId(chatId) !== null) refuse('That conversation has already been used.')
  if (runExecutionService.isRunning(chatId)) {
    refuse('That conversation already has a turn running.')
  }
  return chat
}

/**
 * What a start hands back **inside main**: the IPC result plus the turn's own
 * outcome.
 *
 * `completed` never crosses the bridge — a Promise is not structured-cloneable,
 * and `task:start` strips it for exactly that reason. It exists for a caller
 * that has to know how the turn ended without polling: a file handover whose
 * executor may finish without ever writing `report.md`
 * (`handoverService`, `drafts/file_handovers` §3.6).
 */
export interface DesktopTaskStart extends TaskStartResult {
  completed: Promise<RunOutcome>
}

/** Start the first local conversation after a task is brought to this device. */
export const taskExecutionService = {
  async start(scope: RunScope, taskId: string, target: DesktopTaskTarget, options: TaskStartOptions = {}): Promise<DesktopTaskStart> {
    if (!target || (target.kind !== 'model' && target.kind !== 'agent') ||
      (target.kind === 'agent' && (typeof target.agentId !== 'string' || !target.agentId.trim())) ||
      (target.kind === 'model' && target.modeId !== undefined && typeof target.modeId !== 'string')) {
      throw new TaskError('invalid_input', 'Choose an agent or the model to continue this task.')
    }
    const key = JSON.stringify([scope.profileUserId, taskId])
    if (starting.has(key)) throw new TaskError('invalid_input', 'This task is already starting.')
    starting.add(key)
    let createdChatId: string | null = null
    let accepted = false
    const assertTask = (): TaskDto => {
      if (handingOffTasks.has(taskOperationKey(scope.profileUserId, taskId)) || taskHandoffRepo.unresolved(scope.profileUserId, taskId)) {
        throw new TaskError('handoff_uncertain', 'Resolve this task’s remote handoff before starting it here.')
      }
      userActivation.requireActivated()
      if (getProfileScopeUserId() !== scope.profileUserId) {
        throw new TaskError('invalid_input', 'The active profile changed. Start this task from its profile.')
      }
      const task = taskService.getById(scope.profileUserId, taskId)
      if (task.executor !== 'desktop' || !task.runsHere) {
        throw new TaskError('running_elsewhere', 'Take over this task before starting it here.')
      }
      if (!canTransition(task.status, 'in_progress')) {
        throw new TaskError('invalid_transition', `A ${task.status} task cannot be started.`)
      }
      if (task.router === 'script' || task.script != null) throw new TaskError('invalid_input', 'This task needs its script runner.')
      if (task.chatId && runExecutionService.isRunning(task.chatId)) {
        throw new TaskError('invalid_input', 'This task already has a turn running. Stop it before starting another.')
      }
      if (task.chatId && chatRepo.getOwned(scope.profileUserId, task.chatId)?.deletedAt === null) {
        throw new TaskError('invalid_input', 'This task already has a conversation. Continue it there.')
      }
      if (taskInputRequestRepo.listOpen(scope.profileUserId).some(({ row }) => row.taskId === taskId)) {
        throw new TaskError('invalid_input', 'Answer this task’s pending question in the Inbox first.')
      }
      return task
    }
    try {
      assertTask()
      let model: TaskModelConfig | null = null
      let assignee: TaskAssignee
      let assertAgentCurrent = (): void => {}
      if (target.kind === 'agent') {
        const readAgent = () => {
          const located = agentService.findAgent(scope.settingsUserId, scope.profileUserId, target.agentId)
          const override = agentOverrideRepo.get(scope.profileUserId, target.agentId)
          return located && { ...located, row: { ...located.row, enabled: override?.enabled ?? located.row.enabled } }
        }
        const located = readAgent()
        if (!located || !located.row.enabled) throw new TaskError('invalid_input', 'That agent is unavailable. Choose another agent.')
        const fingerprint = JSON.stringify(located)
        assertAgentCurrent = () => {
          const current = readAgent()
          if (JSON.stringify(current) !== fingerprint) {
            throw new TaskError('invalid_input', 'The agent configuration changed while starting. Try again.')
          }
        }
        const driver = driverFor(located.row)
        const readiness = await driver.readiness(located.userId, located.row)
        if (readiness && readinessBlocksTurn(readiness, driver.capabilities(located.row))) {
          throw new TaskError('invalid_input', readiness.reason ?? 'This agent is not ready. Check its configuration.')
        }
        assignee = { kind: 'agent', agentId: located.row.id, name: located.row.name }
      } else {
        model = await resolveTaskModelConfig(scope, target.modeId)
        assignee = { kind: 'model', agentId: null, name: null }
      }
      const task = assertTask()
      assertAgentCurrent()
      model?.assertCurrent()
      const reused = options.reuseChatId ? adoptChat(scope, task, assignee.agentId, options.reuseChatId) : null
      const chat = reused ?? chatRepo.create(scope.profileUserId, {
        title: task.title, router: 'direct', agentId: assignee.agentId,
        modeId: model?.modeId, providerId: model?.providerId, modelId: model?.modelId
      })
      // Only a chat *this* call created is deleted when the start is refused.
      // A reused one belongs to whoever handed it over, and it is that caller's
      // job to clean it up — deleting it here would take the gate's chat away
      // from a row that may still be settling.
      createdChatId = reused ? null : chat.id
      if (model) chatMcpRepo.replaceForChat(chat.id, model.mcpIds)
      const handle = runExecutionService.start(scope,
        { chatId: chat.id, content: taskContinuationPrompt(task) }, {
          preserveOnRefusal: true,
          observe: (ctx, event) => inboxService.recordRunEvent(ctx, event),
          onAccepted: () => {
            assertTask()
            assertAgentCurrent()
            model?.assertCurrent()
            taskService.beginDesktopChat(scope.profileUserId, taskId, chat.id, assignee)
          }
        })
      await handle.accepted
      accepted = true
      const current = taskService.getById(scope.profileUserId, taskId)
      taskFileService.exportHandoff(current)
      return { task: current, chatId: chat.id, runId: handle.id, completed: handle.completed }
    } catch (error) {
      if (createdChatId && !accepted) chatRepo.permanentDelete(scope.profileUserId, createdChatId)
      throw error
    } finally {
      starting.delete(key)
    }
  }
}
