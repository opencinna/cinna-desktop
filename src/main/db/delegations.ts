import { and, desc, eq, or, isNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { delegationOriginKey, type DelegationDto, type DelegationReply } from '../../shared/delegations'
import { getDb } from './client'
import { delegations, chats, tasks } from './schema'

export type DelegationRow = typeof delegations.$inferSelect
export type DelegationInsert = Pick<
  DelegationRow,
  'userId' | 'requesterKey' | 'originKind' | 'targetKind' | 'targetAgentId' | 'channel' | 'depth'
> &
  Partial<Omit<DelegationRow, 'createdAt' | 'updatedAt'>>
export type DelegationPatch = Partial<Omit<DelegationRow, 'id' | 'userId' | 'createdAt'>>

const SETTLED_STATES = ['done', 'failed', 'skipped', 'refused']

function ownedBy(userId: string) {
  return eq(delegations.userId, userId)
}

function selectOne(...conditions: Parameters<typeof and>): DelegationRow | undefined {
  return getDb().select().from(delegations).where(and(...conditions)).get()
}

function selectAll(...conditions: Parameters<typeof and>): DelegationRow[] {
  return getDb().select().from(delegations).where(and(...conditions)).all()
}

export const delegationRepo = {
  /** Main-only lookup. Callers still validate routing before trusting an origin. */
  originProfile(chatId?: string | null, taskId?: string | null): string | null {
    if (chatId) {
      const chat = getDb().select({ userId: chats.userId }).from(chats).where(eq(chats.id, chatId)).get()
      return chat?.userId ?? null
    }
    if (taskId) {
      const task = getDb().select({ userId: tasks.userId }).from(tasks).where(eq(tasks.id, taskId)).get()
      return task?.userId ?? null
    }
    return null
  },

  insert(input: DelegationInsert): DelegationRow {
    const now = new Date()
    const id = input.id ?? nanoid()
    const row: DelegationRow = {
      id,
      userId: input.userId,
      requesterKey: input.requesterKey,
      originKey: input.originKey ?? delegationOriginKey(input),
      originKind: input.originKind,
      originAgentId: null,
      originChatId: null,
      originTaskId: null,
      originRemoteRef: null,
      targetKind: input.targetKind,
      targetAgentId: input.targetAgentId,
      channel: input.channel,
      rootDelegationId: id,
      depth: input.depth,
      taskId: null,
      handoverId: null,
      title: '',
      brief: '',
      execution: 'ask',
      state: 'seen',
      refusalReason: null,
      warning: null,
      resultStatus: null,
      summary: null,
      question: null,
      resultDigest: null,
      artifacts: [],
      resultBody: null,
      pendingReplies: [],
      questionAudience: null,
      groupId: null,
      wokeAt: null,
      wakeRunId: null,
      wakeDigest: null,
      runId: null,
      gateRequestId: null,
      gateChatId: null,
      remoteConnectionId: null,
      remoteTaskId: null,
      remoteTaskKey: null,
      remoteUrl: null,
      dispatchState: null,
      dispatchError: null,
      createdAt: now,
      updatedAt: now
    }
    Object.assign(row, input, { id })
    getDb().insert(delegations).values(row).run()
    return row
  },

  /** Reserve the requester key and its one executor task in the same commit. */
  createWithTask(input: DelegationInsert, createTask: () => { id: string }): DelegationRow {
    return getDb().transaction(() => {
      const row = this.insert(input)
      const task = createTask()
      return this.update(row.userId, row.id, { taskId: task.id })!
    })
  },

  getById(userId: string, id: string): DelegationRow | undefined {
    return selectOne(ownedBy(userId), eq(delegations.id, id))
  },

  byTaskId(userId: string, taskId: string): DelegationRow | undefined {
    return selectOne(ownedBy(userId), eq(delegations.taskId, taskId))
  },

  /**
   * The delegation an origin is itself working under: by its task, or — for a brief that names only
   * a chat — by the task that chat belongs to. One lookup for depth and for the chain's root, so a
   * brief that leaves `origin.task` out cannot start a fresh chain.
   */
  parentOfOrigin(
    userId: string,
    origin: { taskId?: string | null; chatId?: string | null }
  ): DelegationRow | undefined {
    if (origin.taskId) return this.byTaskId(userId, origin.taskId)
    if (!origin.chatId) return undefined
    const task = getDb()
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.chatId, origin.chatId), isNull(tasks.deletedAt)))
      .orderBy(desc(tasks.updatedAt))
      .get()
    return task ? this.byTaskId(userId, task.id) : undefined
  },

  byHandoverId(userId: string, handoverId: string): DelegationRow | undefined {
    return selectOne(ownedBy(userId), eq(delegations.handoverId, handoverId))
  },

  byRequesterKey(
    userId: string,
    originKey: string,
    targetKind: DelegationRow['targetKind'],
    targetAgentId: string,
    requesterKey: string,
    remoteConnectionId?: string | null
  ): DelegationRow | undefined {
    return selectOne(
      ownedBy(userId),
      eq(delegations.originKey, originKey),
      eq(delegations.targetKind, targetKind),
      eq(delegations.targetAgentId, targetAgentId),
      eq(delegations.requesterKey, requesterKey),
      remoteConnectionId
        ? eq(delegations.remoteConnectionId, remoteConnectionId)
        : isNull(delegations.remoteConnectionId)
    )
  },

  list(userId: string): DelegationRow[] {
    return selectAll(ownedBy(userId))
  },

  listForOrigin(userId: string, chatId: string, taskId?: string | null): DelegationRow[] {
    const fromChat = eq(delegations.originChatId, chatId)
    return selectAll(ownedBy(userId), taskId ? or(fromChat, eq(delegations.originTaskId, taskId)) : fromChat)
  },

  listForOriginTask(userId: string, taskId: string): DelegationRow[] {
    return selectAll(ownedBy(userId), eq(delegations.originTaskId, taskId))
  },

  listForGroup(userId: string, originChatId: string, groupId: string): DelegationRow[] {
    return selectAll(ownedBy(userId), eq(delegations.originChatId, originChatId), eq(delegations.groupId, groupId))
  },

  update(userId: string, id: string, patch: DelegationPatch): DelegationRow | undefined {
    getDb()
      .update(delegations)
      .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
      .where(and(ownedBy(userId), eq(delegations.id, id)))
      .run()
    return this.getById(userId, id)
  },

  appendReply(userId: string, id: string, message: string): DelegationReply {
    return getDb().transaction(() => {
      const row = this.getById(userId, id)
      if (!row) throw new Error('This delegation no longer exists.')
      const reply: DelegationReply = { id: nanoid(), message, state: 'pending' }
      this.update(userId, id, { pendingReplies: [...row.pendingReplies, reply] })
      return reply
    })
  },

  changeReply(
    userId: string,
    id: string,
    replyId: string,
    state: 'sending' | 'pending' | 'remove'
  ): DelegationRow | undefined {
    return getDb().transaction(() => {
      const row = this.getById(userId, id)
      if (!row) return undefined
      const pendingReplies = state === 'remove'
        ? row.pendingReplies.filter((reply) => reply.id !== replyId)
        : row.pendingReplies.map((reply) => (reply.id === replyId ? { ...reply, state } : reply))
      return this.update(userId, id, { pendingReplies })
    })
  },

  /**
   * A cloud create whose acknowledgement has not been stored. Until it is, the remote task has no
   * local binding, and a task pull that met it would import it as somebody else's work.
   */
  unboundCreatePending(userId: string, adapterId: string): boolean {
    const pending = getDb()
      .select({ id: delegations.id })
      .from(delegations)
      // A deleted child is only soft-deleted, so `task_id` stays set: without the join a create
      // nobody will ever retry would hold every import for this profile back for good.
      .innerJoin(tasks, and(eq(tasks.id, delegations.taskId), isNull(tasks.deletedAt)))
      .where(
        and(
          ownedBy(userId),
          eq(delegations.remoteConnectionId, adapterId),
          eq(delegations.dispatchState, 'creating'),
          isNull(delegations.remoteTaskId)
        )
      )
      .get()
    return pending !== undefined
  },

  /** A stale queued packet cannot acknowledge or warn a newer result. */
  recordWake(
    userId: string,
    id: string,
    expectedDigest: string | undefined,
    patch: Pick<DelegationPatch, 'wokeAt' | 'wakeRunId' | 'warning'>
  ): DelegationRow | undefined {
    return getDb().transaction(() => {
      const row = this.getById(userId, id)
      if (!row) return undefined
      const digest = row.resultDigest ?? `state:${row.state}`
      if (expectedDigest !== undefined && digest !== expectedDigest) return undefined
      return this.update(userId, id, patch)
    })
  },

  toDto(row: DelegationRow): DelegationDto {
    const { taskId, resultStatus } = row
    const task = taskId
      ? getDb()
          .select({ deletedAt: tasks.deletedAt })
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.userId, row.userId)))
          .get()
      : null
    const taskGone = !task || !!task.deletedAt
    const state = taskGone && !SETTLED_STATES.includes(row.state) ? 'skipped' : row.state
    const askingUser =
      state === 'gated' || state === 'waiting_user' || (resultStatus === 'blocked' && row.questionAudience === 'user')

    return {
      id: row.id,
      requesterKey: row.requesterKey,
      originKind: row.originKind,
      originAgentId: row.originAgentId,
      originChatId: row.originChatId,
      originTaskId: row.originTaskId,
      targetKind: row.targetKind,
      targetAgentId: row.targetAgentId,
      channel: row.channel,
      rootDelegationId: row.rootDelegationId,
      depth: row.depth,
      taskId: taskGone ? null : taskId,
      handoverId: row.handoverId,
      title: row.title,
      execution: row.execution,
      state,
      refusalReason: row.refusalReason,
      warning: row.warning,
      resultStatus,
      summary: row.summary,
      question: row.question,
      artifacts: row.artifacts,
      groupId: row.groupId,
      runId: row.runId,
      remoteTaskKey: row.remoteTaskKey,
      remoteUrl: row.remoteUrl,
      dispatchError: row.dispatchError ?? null,
      waitingOnUser: state !== 'skipped' && askingUser,
      wokeAt: row.wokeAt?.getTime() ?? null,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime()
    }
  }
}
