import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { taskInputRequests, tasks } from './schema'
import type { InputRequest, InputResumeMode } from '../../shared/runEvents'
import type { RequestResolution } from '../../shared/localAgentRequests'
import type { TaskInputRequestStatus } from '../../shared/tasks'

export type TaskInputRequestRow = typeof taskInputRequests.$inferSelect

/**
 * An open ask, with the one field of its task the inbox needs to render a row.
 *
 * The title is joined rather than fetched per row: the inbox is a flat list and
 * the obvious per-entry `taskRepo.getById` is a query per entry.
 */
export interface OpenInputRequest {
  row: TaskInputRequestRow
  taskTitle: string
}

export interface OpenInputRequestInput {
  /** The run's `requestId`. It **is** the row's id — one id, one row, one answer path. */
  requestId: string
  taskId: string
  chatId: string
  agentId: string
  request: InputRequest
  resume: InputResumeMode
}

/**
 * `task_input_requests` — the persistent twin of `agentTurn/pendingRequests`.
 *
 * The registry is the live address and dies with the turn; this table is what
 * the user sees, and it outlives the chat view. Nothing here reaches a driver:
 * the row records that an ask exists and how it was settled, and
 * `inboxService` is the only thing that writes it.
 *
 * **Every read is scoped through `tasks`, not through `user_id`.** This table
 * has no user column — its task has one — and `taskService.remove` is a *soft*
 * delete, so the `ON DELETE CASCADE` that would have cleaned up after a deleted
 * task never fires. A query that trusted the foreign key would keep offering
 * asks that belong to a task the user has thrown away.
 */
export const taskInputRequestRepo = {
  /**
   * Record an ask the run is now parked on.
   *
   * An id that is already here is **replaced**, not rejected. A driver that
   * re-asks under an id it has used before (a reconnect replaying a permission
   * ask) is describing the same ask a second time, and `pendingRequests` takes
   * the same view one level down — a second registration supersedes the first.
   * The alternative is a row stuck in `answered` under an id the engine is
   * currently parked on.
   */
  open(input: OpenInputRequestInput): TaskInputRequestRow {
    const row: TaskInputRequestRow = {
      id: input.requestId,
      taskId: input.taskId,
      chatId: input.chatId,
      agentId: input.agentId,
      request: input.request,
      resume: input.resume,
      status: 'open',
      resolution: null,
      createdAt: new Date(),
      resolvedAt: null
    }
    getDb()
      .insert(taskInputRequests)
      .values(row)
      .onConflictDoUpdate({ target: taskInputRequests.id, set: row })
      .run()
    return row
  },

  getById(requestId: string): TaskInputRequestRow | undefined {
    return getDb()
      .select()
      .from(taskInputRequests)
      .where(eq(taskInputRequests.id, requestId))
      .get()
  },

  /**
   * Settle an ask, and only if it is still open.
   *
   * The `status = 'open'` guard is what makes the two settle paths safe to run
   * in either order: answering from the inbox writes the row directly, and the
   * `input_resolved` the driver then emits arrives at this method too. Whichever
   * lands first wins; the second gets `undefined` and does nothing, rather than
   * overwriting a resolution with the one the other path derived.
   */
  settle(
    requestId: string,
    status: Exclude<TaskInputRequestStatus, 'open'>,
    resolution: RequestResolution | null = null
  ): TaskInputRequestRow | undefined {
    const result = getDb()
      .update(taskInputRequests)
      .set({ status, resolution, resolvedAt: new Date() })
      .where(and(eq(taskInputRequests.id, requestId), eq(taskInputRequests.status, 'open')))
      .run()
    if (result.changes === 0) return undefined
    return this.getById(requestId)
  },

  /** Every ask this profile is waiting on, newest first. The inbox. */
  listOpen(userId: string): OpenInputRequest[] {
    return getDb()
      .select({ row: taskInputRequests, taskTitle: tasks.title })
      .from(taskInputRequests)
      .innerJoin(tasks, eq(tasks.id, taskInputRequests.taskId))
      .where(
        and(
          eq(tasks.userId, userId),
          isNull(tasks.deletedAt),
          eq(taskInputRequests.status, 'open')
        )
      )
      .orderBy(desc(taskInputRequests.createdAt))
      .all()
  },

  /**
   * Expire every ask still open in a chat, and say how many there were.
   *
   * The other half of {@link taskInputRequestRepo.expireOpen}, and it exists
   * because a driver does **not** always announce the asks it abandons. The ACP
   * driver closes the turn before it releases its parks — `askAgentToStop` sets
   * `turn.open = false` and *then* cancels them, and so does the `finally` — and
   * `input_resolved` is gated on the turn being open. So a stop, the twenty
   * minute ceiling and a crash all settle the registry in silence.
   *
   * Without this a row written by a turn that was stopped would sit open until
   * the next restart: an inbox entry, and a badge counting it, whose only
   * possible outcome is "no longer waiting for an answer". The renderer already
   * compensates for the same silence in its own way (`chat.store.ts`
   * `withoutReplyRequests`); this is that compensation for the record.
   */
  expireOpenForChat(chatId: string): number {
    return getDb()
      .update(taskInputRequests)
      .set({ status: 'expired', resolvedAt: new Date() })
      .where(and(eq(taskInputRequests.chatId, chatId), eq(taskInputRequests.status, 'open')))
      .run().changes
  },

  /**
   * Expire every open ask. Called once at boot, for every profile at once.
   *
   * A `reply` ask is an address inside a driver process on this machine, and no
   * driver process survives a restart — so every row still marked open when the
   * app starts is one nothing can answer. Leaving them would put buttons in the
   * inbox whose only possible outcome is "no longer waiting", which is the lie
   * `expired` exists to replace.
   *
   * A `next_message` ask writes no row (`inboxService`), so there is nothing
   * here that a restart leaves answerable.
   *
   * Returns how many were expired, for the boot log.
   */
  expireOpen(): number {
    return getDb()
      .update(taskInputRequests)
      .set({ status: 'expired', resolvedAt: new Date() })
      .where(eq(taskInputRequests.status, 'open'))
      .run().changes
  }
}
