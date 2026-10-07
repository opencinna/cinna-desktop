import { taskRuntimeService } from '../services/taskRuntimeService'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { taskService } from '../services/taskService'
import { taskAuthoringService } from '../services/taskAuthoringService'
import { inboxService } from '../services/inboxService'
import { delegationQueryService } from '../services/delegationQueryService'
import type { TaskDelegationsDto } from '../../shared/delegations'
import { handoverService } from '../services/handoverService'
import { syncService } from '../services/syncService'
import { taskSyncService } from '../services/taskSyncService'
import { taskExecutionService } from '../services/taskExecutionService'
import { taskRunnerService } from '../services/taskRunnerService'
import type { AutonomousTaskStart } from '../../shared/taskRuntime'
import { parseAnswerPayload } from '../services/askDelivery'
import { TaskError } from '../errors'
import type { TaskHandoffTarget, TaskHandoffOutcome } from '../../shared/taskHandoff'
import { ipcHandle } from './_wrap'
import type { AskAnswerPayload, InboxAnswerResult, InboxSnapshot, TaskDispatchGateResult } from '../../shared/inbox'
import { taskDispatchService } from '../services/taskDispatchService'
import type { HandoverDto } from '../../shared/handovers'
import {
  isTaskPriority,
  TASK_ROUTERS,
  type DesktopTaskTarget,
  type TaskAssigneeInput,
  type TaskCreateInput,
  type TaskCustomFields,
  type TaskDeletePreview,
  type TaskDeleteResult,
  type TaskDto,
  type TaskListQuery,
  type TaskRouter,
  type TaskUpdateInput
} from '../../shared/tasks'
import type { TaskStatus } from '../../shared/taskStatus'
import type { TaskBoardColumn } from '../../shared/folderTasks'
import type { TaskCommentDto } from '../../shared/tasks'

/**
 * `task:*` and `inbox:*` — one module, because the inbox is a view over tasks
 * rather than a domain of its own: every entry in it belongs to a task, and
 * answering one moves that task's status. Splitting them would put two halves
 * of one gesture in two files.
 *
 * Everything here is profile-scoped through `getProfileScopeUserId()`, and the
 * service refuses anything that is not this profile's — no handler passes an
 * id through to a repo.
 *
 * The inbox answers return **data** rather than throwing: a `DomainError`'s
 * code does not survive the trip to the renderer (see `_wrap.ts`), and every
 * failure there is a sentence the user needs to read.
 *
 * ## Why the sync nudge is here and not in `taskService`
 *
 * Notes and jobs call `syncService.markDirty` from their *services*, so an edit
 * reaches the user's other devices on a 1.5 s debounce rather than the 60 s
 * periodic cycle. Tasks cannot: `taskService` is imported by
 * `sync/collections.ts` (the app-sync apply path goes through it, so the
 * exported handoff note follows the row), and `syncService → syncEngine →
 * collections → taskService` would close a cycle if the service imported it
 * back. Nothing imports `ipc/`, so the nudge lives here.
 *
 * That is not merely a workaround — this is the better layer for it. **Only the
 * writes a person makes are nudged.** A run reports its own progress several
 * times a turn through `applyRunState`, and debouncing a full sync cycle onto
 * each of those would be chatty for a row that changes on its own; those stay
 * on the periodic cycle. A take-over is the one that matters most: its whole
 * purpose is to tell another device it has lost the claim, and a minute of
 * silence there is a minute in which both devices believe they own the run.
 */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be text.`)
  return value
}

/** An assignee choice off the wire: an agent id, the model, or nobody (`null`). */
function assigneeInput(value: unknown): TaskAssigneeInput {
  if (value === null) return null
  const raw = value as { kind?: unknown; agentId?: unknown } | undefined
  if (raw?.kind === 'model') return { kind: 'model' }
  if (raw?.kind === 'agent' && typeof raw.agentId === 'string' && raw.agentId.trim()) {
    return { kind: 'agent', agentId: raw.agentId }
  }
  throw new Error('Choose an agent, the default chat model or nobody.')
}

/**
 * Custom fields are forwarded as a plain object and rebuilt key by key by the
 * shared validator in `taskService`; anything that is not an object is refused
 * here rather than read as "none".
 */
function customFieldsInput(value: unknown): TaskCustomFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Custom fields must be a set of named values.')
  }
  return { ...(value as TaskCustomFields) }
}

/** `task:set-status`'s optional word: text up to 200 characters, or nothing. */
export function statusLabelInput(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 200) throw new Error('A status word must be text.')
  return value
}

/** `task:create`, rebuilt field by field — never a spread of what the renderer sent. */
export function parseTaskCreatePayload(payload: unknown): TaskCreateInput {
  const raw = (payload ?? {}) as Record<string, unknown>
  if (typeof raw.title !== 'string') throw new Error('A task needs a title.')
  const input: TaskCreateInput = { title: raw.title }
  const goal = optionalString(raw.goal, 'Goal')
  if (goal !== undefined) input.goal = goal
  const description = optionalString(raw.description, 'Description')
  if (description !== undefined) input.description = description
  if (raw.priority !== undefined) {
    if (!isTaskPriority(raw.priority)) throw new Error('Unknown priority.')
    input.priority = raw.priority
  }
  if (raw.status !== undefined) {
    if (raw.status !== 'new' && raw.status !== 'open') throw new Error('A new task starts in Backlog or Ready.')
    input.status = raw.status
  }
  if (raw.assignee !== undefined) input.assignee = assigneeInput(raw.assignee)
  if (raw.customFields !== undefined) input.customFields = customFieldsInput(raw.customFields)
  if (raw.parentTaskId !== undefined) {
    if (typeof raw.parentTaskId !== 'string' || !raw.parentTaskId.trim()) throw new Error('A parent task needs an id.')
    input.parentTaskId = raw.parentTaskId
  }
  return input
}

/** `task:update`, rebuilt field by field. */
export function parseTaskUpdatePayload(payload: unknown): TaskUpdateInput {
  const raw = (payload ?? {}) as Record<string, unknown>
  const patch: TaskUpdateInput = {}
  const title = optionalString(raw.title, 'Title')
  if (title !== undefined) patch.title = title
  if (raw.description !== undefined) {
    if (raw.description !== null && typeof raw.description !== 'string') throw new Error('Description must be text.')
    patch.description = raw.description
  }
  if (raw.priority !== undefined) {
    if (!isTaskPriority(raw.priority)) throw new Error('Unknown priority.')
    patch.priority = raw.priority
  }
  if (raw.router !== undefined) {
    if (!(TASK_ROUTERS as readonly unknown[]).includes(raw.router)) throw new Error('Unknown router.')
    patch.router = raw.router as TaskRouter
  }
  if (raw.assignee !== undefined) patch.assignee = assigneeInput(raw.assignee)
  if (raw.customFields !== undefined) patch.customFields = raw.customFields === null ? null : customFieldsInput(raw.customFields)
  return patch
}

export function registerTaskHandlers(): void {
  ipcHandle('task:run-autonomously', async (_event, input: AutonomousTaskStart) => {
    userActivation.requireActivated()
    const profileUserId = getProfileScopeUserId()
    const result = taskRunnerService.start({ profileUserId, settingsUserId: getSettingsScopeUserId() }, input)
    syncService.markDirty(profileUserId)
    return result
  })
  ipcHandle('task:resume-runtime', async (_event, taskId: string) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    taskRuntimeService.resume(userId, taskId)
    syncService.markDirty(userId)
  })
  ipcHandle('task:stop-runtime', async (_event, taskId: string) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    taskRuntimeService.cancel(userId, taskId)
    syncService.markDirty(userId)
  })
  ipcHandle('task:list', async (_event, query?: TaskListQuery): Promise<TaskDto[]> => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    // A malformed chat filter is refused rather than dropped: dropped, it would
    // widen one chat's list into every task the profile has.
    const chatId = query?.chatId
    if (chatId !== undefined && (typeof chatId !== 'string' || chatId === '')) {
      throw new Error('A task list filter needs a chat id.')
    }
    // Rebuilt field by field rather than forwarded: the repo's filter has an
    // arm (`remoteAdapter`) that belongs to the adapters and to
    // `taskSyncService`, and a renderer must not be able to reach it.
    return taskService.list(userId, {
      statuses: query?.statuses,
      executor: query?.executor,
      parentTaskId: query?.parentTaskId,
      rootOnly: query?.rootOnly,
      chatId,
      includeArchived: query?.includeArchived
    })
  })

  ipcHandle('task:get', async (_event, taskId: string): Promise<TaskDto> => {
    userActivation.requireActivated()
    return taskSyncService.getWatched(getProfileScopeUserId(), taskId)
  })

  ipcHandle('task:children', async (_event, taskId: string) => {
    userActivation.requireActivated()
    return taskSyncService.getChildren(getProfileScopeUserId(), taskId)
  })

  ipcHandle('task:handoff-receipt', async (_event, taskId: string) => {
    userActivation.requireActivated()
    return taskSyncService.handoffReceipt(getProfileScopeUserId(), taskId)
  })
  ipcHandle('task:chat-handoff', async (_event, chatId: string) => {
    userActivation.requireActivated()
    return taskSyncService.pendingHandoffForChat(getProfileScopeUserId(), chatId)
  })
  ipcHandle('task:resolve-handoff', async (_event, taskId: string) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    await taskSyncService.resolveHandoff(userId, taskId)
    syncService.markDirty(userId)
  })

  ipcHandle('task:handoff-options', async (_event, taskId: string) => {
    userActivation.requireActivated()
    return taskSyncService.handoffOptions(getProfileScopeUserId(), taskId)
  })

  ipcHandle('task:hand-off', async (_event, taskId: string, target: TaskHandoffTarget, note: string | null): Promise<TaskHandoffOutcome> => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    // A renderer handoff always names a target; only internal jobs may reuse assignment.
    if (!target || typeof target !== 'object') return { kind: 'refused', message: 'Choose a remote agent.' }
    try {
      const task = await taskSyncService.handOff(userId, taskId, target, note)
      syncService.markDirty(userId)
      return { kind: 'accepted', task, receipt: taskSyncService.handoffReceipt(userId, taskId) ?? undefined, message: 'Task handed off.' }
    } catch (error) {
      const kind = error instanceof TaskError && error.code === 'handed_over' ? 'attention'
        : error instanceof TaskError && error.code === 'handoff_uncertain' ? 'uncertain' : 'refused'
      return { kind, receipt: taskSyncService.handoffReceipt(userId, taskId) ?? undefined,
        message: error instanceof Error ? error.message : 'This task could not be handed off.' }
    }
  })

  ipcHandle('task:start', async (_event, taskId: string, target: DesktopTaskTarget) => {
    userActivation.requireActivated()
    const profileUserId = getProfileScopeUserId()
    // `completed` is dropped rather than forwarded: it is a Promise, which
    // `ipcMain.handle`'s structured clone cannot carry, and returning the whole
    // object would fail the call outright. Main-side callers that need the
    // turn's outcome call the service directly.
    const { task, chatId, runId } = await taskExecutionService.start(
      { profileUserId, settingsUserId: getSettingsScopeUserId() }, taskId, target, { startedBy: 'user' })
    syncService.markDirty(profileUserId)
    return { task, chatId, runId }
  })

  /**
   * A task the user wrote down by hand (the Tasks view's New task, or the task
   * page's Add subtask with `parentTaskId`). Main fills in everything but the
   * title (`taskAuthoringService.create`) and checks the parent; the handoff
   * export follows through `taskService.create`. A refusal is a thrown
   * sentence, which the dialog shows through `unwrapIpcError`.
   */
  ipcHandle('task:create', async (_event, payload: unknown): Promise<TaskDto> => {
    userActivation.requireActivated()
    const profileUserId = getProfileScopeUserId()
    const task = await taskAuthoringService.createRouted(
      { profileUserId, settingsUserId: getSettingsScopeUserId() }, parseTaskCreatePayload(payload))
    syncService.markDirty(profileUserId)
    return task
  })

  /**
   * Title, description, priority, router and custom fields — writable whoever
   * is running the task — and the assignee, which main refuses once a run
   * could have started from it.
   */
  ipcHandle('task:update', async (_event, taskId: string, patch: unknown) => {
    userActivation.requireActivated()
    const profileUserId = getProfileScopeUserId()
    const task = taskAuthoringService.update(
      { profileUserId, settingsUserId: getSettingsScopeUserId() }, taskId, parseTaskUpdatePayload(patch))
    syncService.markDirty(profileUserId)
    return task
  })

  /**
   * A status the **user** chose — cancel, archive, reopen a failed one.
   *
   * Through `setStatus`, so it is validated against the transition table and
   * refused when the task is running somewhere else. A run reporting its own
   * progress does not come through here; it goes through `applyRunState`, which
   * is the one path allowed to be lenient about a step the table forbids.
   */
  ipcHandle('task:set-status', async (_event, taskId: string, status: TaskStatus, label?: unknown) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    // A person's move: the remote table plus the manual overlay for unbound
    // tasks (and for a folder task, whose file keeps no table). `label` is the
    // folder's own word for the column it was dropped on.
    const task = await taskAuthoringService.setStatus(
      { profileUserId: userId, settingsUserId: getSettingsScopeUserId() }, taskId, status, statusLabelInput(label))
    syncService.markDirty(userId)
    return task
  })

  /**
   * A task's comments, oldest first — the task page's read-only Comments list.
   * Rebuilt field by field: nothing beyond the DTO's fields crosses.
   */
  ipcHandle('task:comments', async (_event, taskId: unknown): Promise<TaskCommentDto[]> => {
    userActivation.requireActivated()
    if (typeof taskId !== 'string' || !taskId) throw new Error('Comments need a task id.')
    const { taskToolService } = await import('../services/taskToolService')
    return taskToolService.comments({ profileUserId: getProfileScopeUserId(), settingsUserId: getSettingsScopeUserId() }, taskId)
      .map((comment) => ({
        id: comment.id,
        authorKind: comment.authorKind,
        authorAgentId: comment.authorAgentId,
        authorName: comment.authorName,
        body: comment.body,
        createdAt: comment.createdAt,
        remoteStatus: comment.remoteStatus
      }))
  })

  /**
   * The status columns of a bare agent's folder board, left to right: its
   * `_board.yaml` words, then default words its files use, then unmapped
   * words. Null when that agent's tasks are not kept in its folder.
   */
  ipcHandle('task:folder-board', async (_event, agentId: unknown): Promise<TaskBoardColumn[] | null> => {
    userActivation.requireActivated()
    if (typeof agentId !== 'string' || !agentId) throw new Error('A folder board needs an agent id.')
    const columns = await taskSyncService.folderBoard(getProfileScopeUserId(), agentId)
    // Rebuilt field by field: nothing beyond the four documented fields crosses.
    return columns?.map((column) => ({
      label: column.label,
      category: column.category,
      status: column.status,
      droppable: column.droppable
    })) ?? null
  })

  /**
   * *Re-run from the last message*: back to `in_progress` with the checks
   * `task:set-status` applies, and a job run this task owns reopened with it,
   * so the re-run's outcome finishes both (`taskService.reopenForRerun`).
   */
  ipcHandle('task:reopen-for-rerun', async (_event, taskId: string) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    const task = taskService.reopenForRerun(userId, taskId)
    syncService.markDirty(userId)
    return task
  })

  /**
   * Is something working on this task in the service that holds it?
   *
   * A network question, which is why it is a channel of its own rather than a
   * field on `TaskDto`: the DTO is built from a row, synchronously, at thirteen
   * call sites. `null` is a real answer and the renderer has to render it —
   * §5.10 confirms rather than refuses when nobody can tell.
   *
   * Asked once, when a take-over control is about to be shown. It is **not**
   * the authority: `task:take-over` asks again on the far side of the user's
   * gesture, because an agent can start in the seconds between.
   */
  ipcHandle('task:remote-live', async (_event, taskId: string): Promise<boolean | null> => {
    userActivation.requireActivated()
    return taskSyncService.liveSession(getProfileScopeUserId(), taskId)
  })

  /**
   * Continue a task here — from another device, or from a bound service.
   *
   * Through `taskSyncService` rather than `taskService`, because one of the two
   * elsewheres is on a network: a task a remote agent is working on right now
   * refuses the take-over (§5.10), and asking costs a request. The device half
   * needs nothing and falls straight through.
   *
   * `force` is the answer to a service that could not say. §5.10 confirms
   * rather than refuses there, so the renderer asks the user and sends it back.
   *
   * The nudge matters most on this one. The claim only means anything once the
   * other device has read it, and until then both of them pass `taskRunsHere`
   * and both will happily write the run. On the periodic cycle alone that
   * window is up to a minute wide; the debounce closes it to seconds.
   */
  ipcHandle('task:take-over', async (_event, taskId: string, force?: boolean) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    const task = await taskSyncService.takeOver(userId, taskId, { force: force === true })
    syncService.markDirty(userId)
    return task
  })


  /**
   * What `task:delete` would remove, read before its confirm dialog opens so
   * the dialog's copy is final and true. A read: it nudges nothing.
   */
  ipcHandle('task:delete-preview', async (_event, taskId: string): Promise<TaskDeletePreview> => {
    userActivation.requireActivated()
    return taskService.deletePreview(getProfileScopeUserId(), taskId)
  })

  /**
   * The task page's Delete task. A task a live job run produced takes that run
   * and its chat with it, in one transaction (`removeWithJobRun`), and a task
   * kept in its agent's folder takes its file (`taskSyncService.removeTask`);
   * what was removed comes back as data, so the renderer knows which caches to drop.
   */
  ipcHandle('task:delete', async (_event, taskId: string): Promise<TaskDeleteResult> => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    const result = await taskSyncService.removeTask(userId, taskId)
    syncService.markDirty(userId)
    return { success: true, ...result }
  })

  /**
   * Everything waiting on the user, newest first, plus the services this read
   * could not reach — an unreadable remote leaves a hole in the list rather
   * than taking the local asks down with it.
   */
  ipcHandle('inbox:list', async (): Promise<InboxSnapshot> => {
    userActivation.requireActivated()
    return inboxService.list(getProfileScopeUserId())
  })

  ipcHandle('delegation:for-task', async (_event, input: { taskId: string }): Promise<TaskDelegationsDto> => {
    userActivation.requireActivated()
    const taskId = typeof input?.taskId === 'string' ? input.taskId : ''
    if (!taskId) return { from: null, to: [] }
    return delegationQueryService.forTask(getProfileScopeUserId(), taskId)
  })

  /**
   * The file handover a task came from, or null for an ordinary task.
   *
   * Profile scope, like the task itself. Keyed by the task rather than by the
   * handover id because that is what the task page has, and because
   * `tasks.origin` is a closed `local | remote` union that cannot say
   * "handover" — the row *is* the link.
   */
  ipcHandle('handover:for-task', async (_event, input: { taskId: string }): Promise<HandoverDto | null> => {
    userActivation.requireActivated()
    const taskId = typeof input?.taskId === 'string' ? input.taskId : ''
    if (!taskId) return null
    return handoverService.forTask(getProfileScopeUserId(), taskId)
  })

  /**
   * Answer an ask from the inbox — the same answer the transcript's own block
   * sends, for a chat the user may have closed hours ago.
   */
  ipcHandle('inbox:answer', async (_event, data: AskAnswerPayload): Promise<InboxAnswerResult> => {
    userActivation.requireActivated()
    const parsed = parseAnswerPayload(data)
    if (!parsed) return { ok: false, reason: 'Malformed answer', code: 'malformed' }
    return inboxService.answer(getProfileScopeUserId(), data.requestId, parsed)
  })

  /**
   * Answer the task dispatcher's approval of outside content
   * (`TaskDispatchGateItem`): `approve` trusts that content and runs the task
   * when its agent and folder are free, `skip` leaves it untrusted.
   */
  ipcHandle('inbox:dispatch-gate', async (_event, gateId: unknown, action: unknown): Promise<TaskDispatchGateResult> => {
    userActivation.requireActivated()
    if (action !== 'approve' && action !== 'skip') {
      return { ok: false, code: 'unavailable', reason: 'Choose Approve and run or Skip.' }
    }
    return taskDispatchService.answerGate(
      { profileUserId: getProfileScopeUserId(), settingsUserId: getSettingsScopeUserId() }, gateId, action)
  })
}
