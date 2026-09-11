import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { taskService, type TaskFieldPatch } from '../services/taskService'
import { inboxService } from '../services/inboxService'
import { syncService } from '../services/syncService'
import { taskSyncService } from '../services/taskSyncService'
import { parseAnswerPayload } from '../services/askDelivery'
import { ipcHandle } from './_wrap'
import type { AskAnswerPayload, InboxAnswerResult, InboxEntry } from '../../shared/inbox'
import type { TaskDto, TaskListQuery } from '../../shared/tasks'
import type { TaskStatus } from '../../shared/taskStatus'

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
export function registerTaskHandlers(): void {
  ipcHandle('task:list', async (_event, query?: TaskListQuery): Promise<TaskDto[]> => {
    userActivation.requireActivated()
    // Rebuilt field by field rather than forwarded: the repo's filter has an
    // arm (`remoteAdapter`) that belongs to the adapters and to
    // `taskSyncService`, and a renderer must not be able to reach it.
    return taskService.list(getProfileScopeUserId(), {
      statuses: query?.statuses,
      executor: query?.executor,
      parentTaskId: query?.parentTaskId,
      rootOnly: query?.rootOnly,
      includeArchived: query?.includeArchived
    })
  })

  ipcHandle('task:get', async (_event, taskId: string): Promise<TaskDto> => {
    userActivation.requireActivated()
    return taskService.getById(getProfileScopeUserId(), taskId)
  })

  /** Title, description, priority, router — writable whoever is running the task. */
  ipcHandle('task:update', async (_event, taskId: string, patch: TaskFieldPatch) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    const task = taskService.update(userId, taskId, patch ?? {})
    syncService.markDirty(userId)
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
  ipcHandle('task:set-status', async (_event, taskId: string, status: TaskStatus) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    const task = taskService.setStatus(userId, taskId, status)
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


  ipcHandle('task:delete', async (_event, taskId: string) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    taskService.remove(userId, taskId)
    syncService.markDirty(userId)
    return { success: true }
  })

  /** Everything waiting on the user, newest first. */
  ipcHandle('inbox:list', async (): Promise<InboxEntry[]> => {
    userActivation.requireActivated()
    return inboxService.list(getProfileScopeUserId())
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
}
