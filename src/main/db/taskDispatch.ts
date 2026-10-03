import { and, desc, eq, isNotNull, ne } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { agentTaskDispatch, taskDispatchGates } from './schema'
import type { TaskDispatchMode, TaskDispatchPauseReason } from '../../shared/taskDispatch'

export type AgentTaskDispatchRow = typeof agentTaskDispatch.$inferSelect
export type TaskDispatchGateRow = typeof taskDispatchGates.$inferSelect

/** What a profile's agent has when it has no row: manual, not paused, nothing in flight. */
function emptyRow(userId: string, agentId: string): AgentTaskDispatchRow {
  return {
    userId, agentId, mode: 'manual', pausedReason: null, pausedTaskId: null, pausedAt: null,
    activeTaskId: null, activeChatId: null, updatedAt: new Date(0)
  }
}

type DispatchPatch = Partial<Omit<AgentTaskDispatchRow, 'userId' | 'agentId' | 'updatedAt'>>

/**
 * Per-profile, device-local dispatch state of each folder agent
 * (`agent_task_dispatch`). A row that has gone back to all defaults is
 * deleted, so "no row" keeps meaning manual and idle.
 */
export const agentTaskDispatchRepo = {
  get(userId: string, agentId: string): AgentTaskDispatchRow {
    return getDb().select().from(agentTaskDispatch)
      .where(and(eq(agentTaskDispatch.userId, userId), eq(agentTaskDispatch.agentId, agentId))).get() ??
      emptyRow(userId, agentId)
  },

  listForUser(userId: string): AgentTaskDispatchRow[] {
    return getDb().select().from(agentTaskDispatch).where(eq(agentTaskDispatch.userId, userId)).all()
  },

  /** Every row, of every profile, that still names a run in flight — the boot sweep's input. */
  listActive(): AgentTaskDispatchRow[] {
    return getDb().select().from(agentTaskDispatch).where(isNotNull(agentTaskDispatch.activeTaskId)).all()
  },

  patch(userId: string, agentId: string, patch: DispatchPatch): AgentTaskDispatchRow {
    const next = { ...this.get(userId, agentId), ...patch, userId, agentId, updatedAt: new Date() }
    const idle = next.mode === 'manual' && !next.pausedReason && !next.activeTaskId && !next.activeChatId
    const db = getDb()
    if (idle) {
      db.delete(agentTaskDispatch)
        .where(and(eq(agentTaskDispatch.userId, userId), eq(agentTaskDispatch.agentId, agentId))).run()
      return emptyRow(userId, agentId)
    }
    db.insert(agentTaskDispatch).values(next).onConflictDoUpdate({
      target: [agentTaskDispatch.userId, agentTaskDispatch.agentId],
      set: {
        mode: next.mode,
        pausedReason: next.pausedReason,
        pausedTaskId: next.pausedTaskId,
        pausedAt: next.pausedAt,
        activeTaskId: next.activeTaskId,
        activeChatId: next.activeChatId,
        updatedAt: next.updatedAt
      }
    }).run()
    return next
  },

  setMode(userId: string, agentId: string, mode: TaskDispatchMode): AgentTaskDispatchRow {
    return this.patch(userId, agentId, { mode })
  },

  pause(userId: string, agentId: string, reason: TaskDispatchPauseReason, taskId: string | null, at = new Date()): AgentTaskDispatchRow {
    return this.patch(userId, agentId, { pausedReason: reason, pausedTaskId: taskId, pausedAt: at })
  },

  resume(userId: string, agentId: string): AgentTaskDispatchRow {
    return this.patch(userId, agentId, { pausedReason: null, pausedTaskId: null, pausedAt: null })
  },

  setActive(userId: string, agentId: string, taskId: string | null, chatId: string | null): AgentTaskDispatchRow {
    return this.patch(userId, agentId, { activeTaskId: taskId, activeChatId: chatId })
  }
}

/** The dispatcher's outside-content approvals (`task_dispatch_gates`). */
export const taskDispatchGateRepo = {
  getById(userId: string, id: string): TaskDispatchGateRow | undefined {
    return getDb().select().from(taskDispatchGates)
      .where(and(eq(taskDispatchGates.id, id), eq(taskDispatchGates.userId, userId))).get()
  },

  forDigest(userId: string, taskId: string, digest: string): TaskDispatchGateRow | undefined {
    return getDb().select().from(taskDispatchGates)
      .where(and(eq(taskDispatchGates.userId, userId), eq(taskDispatchGates.taskId, taskId), eq(taskDispatchGates.digest, digest))).get()
  },

  listOpen(userId: string): TaskDispatchGateRow[] {
    return getDb().select().from(taskDispatchGates)
      .where(and(eq(taskDispatchGates.userId, userId), eq(taskDispatchGates.status, 'open')))
      .orderBy(desc(taskDispatchGates.createdAt)).all()
  },

  /**
   * The card for this content, opened now, with every older open card of the
   * task settled as superseded: the file changed, and the old body is no
   * longer what would be sent.
   */
  open(userId: string, input: { taskId: string; agentId: string; digest: string; title: string; filePath: string | null; body: string }): TaskDispatchGateRow {
    const db = getDb()
    return db.transaction(() => {
      const now = new Date()
      db.update(taskDispatchGates).set({ status: 'superseded', settledAt: now })
        .where(and(eq(taskDispatchGates.userId, userId), eq(taskDispatchGates.taskId, input.taskId),
          eq(taskDispatchGates.status, 'open'), ne(taskDispatchGates.digest, input.digest))).run()
      const row: TaskDispatchGateRow = { id: `dgate_${nanoid()}`, userId, ...input, status: 'open', createdAt: now, settledAt: null }
      db.insert(taskDispatchGates).values(row).run()
      return row
    })
  },

  /** Settle an open card. False when it was no longer open. */
  settle(userId: string, id: string, status: 'approved' | 'skipped' | 'superseded'): boolean {
    return getDb().update(taskDispatchGates).set({ status, settledAt: new Date() })
      .where(and(eq(taskDispatchGates.id, id), eq(taskDispatchGates.userId, userId), eq(taskDispatchGates.status, 'open')))
      .run().changes > 0
  },

  /** A skipped card asked for again by Run next. */
  reopen(userId: string, id: string): void {
    getDb().update(taskDispatchGates).set({ status: 'open', settledAt: null, createdAt: new Date() })
      .where(and(eq(taskDispatchGates.id, id), eq(taskDispatchGates.userId, userId))).run()
  }
}
