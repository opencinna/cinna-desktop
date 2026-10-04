import { and, asc, desc, eq, ne } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { agentTaskDispatch, agentTaskDispatchRuns, taskDispatchGates } from './schema'
import type { TaskDispatchMode, TaskDispatchPauseReason } from '../../shared/taskDispatch'

export type AgentTaskDispatchRow = typeof agentTaskDispatch.$inferSelect
export type AgentTaskDispatchRunRow = typeof agentTaskDispatchRuns.$inferSelect
export type TaskDispatchGateRow = typeof taskDispatchGates.$inferSelect

/** What a profile's agent has when it has no row: manual, not paused. */
function emptyRow(userId: string, agentId: string): AgentTaskDispatchRow {
  return {
    userId, agentId, mode: 'manual', maxRuns: null, pausedReason: null, pausedTaskId: null, pausedAt: null,
    updatedAt: new Date(0)
  }
}

type DispatchPatch = Partial<Omit<AgentTaskDispatchRow, 'userId' | 'agentId' | 'updatedAt'>>

/**
 * Per-profile, device-local dispatch state of each folder agent
 * (`agent_task_dispatch`, and its runs in flight in
 * `agent_task_dispatch_runs`). A row that has gone back to all defaults is
 * deleted, so "no row" keeps meaning manual and not paused.
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

  /** Every dispatched run in flight, of every profile, oldest first — the boot sweep's input. */
  listActive(): AgentTaskDispatchRunRow[] {
    return getDb().select().from(agentTaskDispatchRuns)
      .orderBy(asc(agentTaskDispatchRuns.startedAt), asc(agentTaskDispatchRuns.taskId)).all()
  },

  /** One agent's runs in flight, oldest first. */
  listRuns(userId: string, agentId: string): AgentTaskDispatchRunRow[] {
    return getDb().select().from(agentTaskDispatchRuns)
      .where(and(eq(agentTaskDispatchRuns.userId, userId), eq(agentTaskDispatchRuns.agentId, agentId)))
      .orderBy(asc(agentTaskDispatchRuns.startedAt), asc(agentTaskDispatchRuns.taskId)).all()
  },

  patch(userId: string, agentId: string, patch: DispatchPatch): AgentTaskDispatchRow {
    const next = { ...this.get(userId, agentId), ...patch, userId, agentId, updatedAt: new Date() }
    // N belongs to `up_to` alone, so a row back at manual and idle is no row.
    if (next.mode !== 'up_to') next.maxRuns = null
    const idle = next.mode === 'manual' && !next.pausedReason
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
        maxRuns: next.maxRuns,
        pausedReason: next.pausedReason,
        pausedTaskId: next.pausedTaskId,
        pausedAt: next.pausedAt,
        updatedAt: next.updatedAt
      }
    }).run()
    return next
  },

  /** `maxRuns` is kept only for `up_to`. */
  setMode(userId: string, agentId: string, mode: TaskDispatchMode, maxRuns: number | null = null): AgentTaskDispatchRow {
    return this.patch(userId, agentId, { mode, maxRuns: mode === 'up_to' ? maxRuns : null })
  },

  pause(userId: string, agentId: string, reason: TaskDispatchPauseReason, taskId: string | null, at = new Date()): AgentTaskDispatchRow {
    return this.patch(userId, agentId, { pausedReason: reason, pausedTaskId: taskId, pausedAt: at })
  },

  resume(userId: string, agentId: string): AgentTaskDispatchRow {
    return this.patch(userId, agentId, { pausedReason: null, pausedTaskId: null, pausedAt: null })
  },

  /** Record a run in flight (`chatId` null until it is accepted), or give it its chat. */
  setActive(userId: string, agentId: string, taskId: string, chatId: string | null): void {
    getDb().insert(agentTaskDispatchRuns).values({ userId, agentId, taskId, chatId, startedAt: new Date() })
      .onConflictDoUpdate({
        target: [agentTaskDispatchRuns.userId, agentTaskDispatchRuns.agentId, agentTaskDispatchRuns.taskId],
        set: { chatId }
      }).run()
  },

  /** The run is settled, never started, or flagged at boot: no longer in flight. */
  clearActive(userId: string, agentId: string, taskId: string): void {
    getDb().delete(agentTaskDispatchRuns)
      .where(and(eq(agentTaskDispatchRuns.userId, userId), eq(agentTaskDispatchRuns.agentId, agentId),
        eq(agentTaskDispatchRuns.taskId, taskId))).run()
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
