import { and, desc, eq, isNull, or } from 'drizzle-orm'
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
  /** Reply address, or the Inbox-generated address of a next-message occurrence. */
  requestId: string
  taskId: string
  chatId: string
  agentId: string | null
  deliveryOwner?: 'driver' | 'runner' | 'handover'
  rootRunId?: string
  invocationId?: string
  request: InputRequest
  resume: InputResumeMode
}

/**
 * `task_input_requests` — the persistent twin of `agents/drivers/pendingRequests`.
 *
 * The registry is the live address and dies with the turn; this table is what
 * the user sees, and it outlives the chat view. Nothing here reaches a driver:
 * the row records that an ask exists and how it was settled, and
 * `inboxService` writes asks and answers; task terminal writes expire them.
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
    // `handover` sits on the runner side of this invariant, and for the same
    // reason: there is no engine parked on it. A driver row names the agent its
    // answer is delivered to; a runner gate and a handover gate are answered by
    // a service that looks the task up itself, so naming an agent there would be
    // a claim nothing checks. A handover gate goes one step further — at the
    // moment it is opened no turn exists at all — which is why `reply` is
    // required too: `next_message` means "the answer is the next thing typed in
    // the chat", and the gate's chat has never been used.
    const ownerless = input.deliveryOwner === 'runner' || input.deliveryOwner === 'handover'
    if (ownerless ? input.agentId !== null || input.resume !== 'reply' : !input.agentId) {
      throw new Error('The request needs a valid driver, runner or handover delivery owner.')
    }
    const row: TaskInputRequestRow = {
      id: input.requestId,
      taskId: input.taskId,
      chatId: input.chatId,
      agentId: input.agentId,
      deliveryOwner: input.deliveryOwner ?? 'driver',
      rootRunId: input.rootRunId ?? null,
      invocationId: input.invocationId ?? null,
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
    resolution: RequestResolution | null = null,
    scope?: { chatId: string; rootRunId?: string; invocationId?: string; createdAt?: Date }
  ): TaskInputRequestRow | undefined {
    const result = getDb()
      .update(taskInputRequests)
      .set({ status, resolution, resolvedAt: new Date() })
      .where(and(eq(taskInputRequests.id, requestId), eq(taskInputRequests.status, 'open'),
        scope ? eq(taskInputRequests.chatId, scope.chatId) : undefined,
        scope ? scope.rootRunId ? eq(taskInputRequests.rootRunId, scope.rootRunId) : isNull(taskInputRequests.rootRunId) : undefined,
        scope ? scope.invocationId ? eq(taskInputRequests.invocationId, scope.invocationId) : isNull(taskInputRequests.invocationId) : undefined,
        scope?.createdAt ? eq(taskInputRequests.createdAt, scope.createdAt) : undefined))
      .run()
    if (result.changes === 0) return undefined
    return this.getById(requestId)
  },

  assertReplyCurrent(userId: string, expected: TaskInputRequestRow): void {
    const current = this.getById(expected.id)
    const task = getDb().select().from(tasks).where(and(eq(tasks.id, expected.taskId), eq(tasks.userId, userId))).get()
    if (!current || current.status !== 'open' || current.taskId !== expected.taskId ||
      current.chatId !== expected.chatId || current.agentId !== expected.agentId ||
      current.rootRunId !== expected.rootRunId || current.invocationId !== expected.invocationId ||
      current.createdAt.getTime() !== expected.createdAt.getTime() ||
      current.resume !== 'reply' || current.deliveryOwner !== 'driver' || !task || task.deletedAt ||
      task.chatId !== expected.chatId || task.executor !== 'desktop') {
      throw new Error('The request or its task changed before the answer could be recorded.')
    }
  },

  /** Keep exact reply settlement and its aggregate task update in one transaction. */
  commitReply(
    userId: string,
    expected: TaskInputRequestRow,
    status: Exclude<TaskInputRequestStatus, 'open'>,
    resolution: RequestResolution,
    updateTask: (taskId: string) => void
  ): void {
    getDb().transaction(() => {
      this.assertReplyCurrent(userId, expected)
      const current = expected
      const saved = this.settle(current.id, status, resolution, {
        chatId: current.chatId, rootRunId: current.rootRunId ?? undefined, invocationId: current.invocationId ?? undefined, createdAt: current.createdAt
      })
      if (!saved) throw new Error('The request is no longer open.')
      updateTask(current.taskId)
    })
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

  /** Expire durable continuation asks when their task can no longer resume. */
  expireNextMessageForTask(taskId: string): void {
    getDb().update(taskInputRequests).set({ status: 'expired', resolvedAt: new Date() })
      .where(and(eq(taskInputRequests.taskId, taskId), eq(taskInputRequests.status, 'open'),
        or(eq(taskInputRequests.resume, 'next_message'), eq(taskInputRequests.deliveryOwner, 'runner'),
          // A handover gate asks whether to *start* the task. Once the task is
          // settled the question has no answer left that means anything, and an
          // unexpired row would keep offering Run for work that is over.
          eq(taskInputRequests.deliveryOwner, 'handover')))).run()
  },

  listOpenForChat(chatId: string): TaskInputRequestRow[] {
    return getDb().select().from(taskInputRequests).where(and(
      eq(taskInputRequests.chatId, chatId), eq(taskInputRequests.status, 'open')
    )).all()
  },

  listOpenForTask(taskId: string): TaskInputRequestRow[] {
    return getDb().select().from(taskInputRequests).where(and(
      eq(taskInputRequests.taskId, taskId), eq(taskInputRequests.status, 'open')
    )).all()
  },

  listOpenForRun(chatId: string, rootRunId: string): TaskInputRequestRow[] {
    return getDb().select().from(taskInputRequests).where(and(
      eq(taskInputRequests.chatId, chatId), eq(taskInputRequests.rootRunId, rootRunId), eq(taskInputRequests.status, 'open')
    )).all()
  },

  expireOpenForRun(chatId: string, rootRunId: string, replyOnly: boolean, invocationId?: string): number {
    return getDb().update(taskInputRequests).set({ status: 'expired', resolvedAt: new Date() })
      .where(and(eq(taskInputRequests.chatId, chatId), eq(taskInputRequests.rootRunId, rootRunId),
        eq(taskInputRequests.status, 'open'), eq(taskInputRequests.deliveryOwner, 'driver'), replyOnly ? eq(taskInputRequests.resume, 'reply') : undefined,
        invocationId ? eq(taskInputRequests.invocationId, invocationId) : undefined)).run().changes
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
  expireOpenForChat(chatId: string, replyOnly = false, nextMessageAgentId?: string): number {
    return getDb()
      .update(taskInputRequests)
      .set({ status: 'expired', resolvedAt: new Date() })
      .where(and(eq(taskInputRequests.chatId, chatId), eq(taskInputRequests.status, 'open'),
        eq(taskInputRequests.deliveryOwner, 'driver'), replyOnly ? eq(taskInputRequests.resume, 'reply') : undefined,
        nextMessageAgentId ? or(eq(taskInputRequests.resume, 'reply'), eq(taskInputRequests.agentId, nextMessageAgentId)) : undefined))
      .run().changes
  },

  /**
   * Boot invalidates only reply addresses backed by a dead driver process.
   * Next-message requests retain their persisted session and remain answerable.
   */
  expireOpen(): number {
    return getDb()
      .update(taskInputRequests)
      .set({ status: 'expired', resolvedAt: new Date() })
      .where(and(eq(taskInputRequests.status, 'open'), eq(taskInputRequests.resume, 'reply'), eq(taskInputRequests.deliveryOwner, 'driver')))
      .run().changes
  }
}
