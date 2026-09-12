import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { taskScriptRuntimes, tasks } from './schema'
import type { ScriptRuntimeCheckpoint } from '../tasks/scriptRuntimeTypes'
import type { TaskRuntimeInfo } from '../../shared/taskRuntime'

export const scriptRuntimeRepo = {
  get(userId: string, taskId: string): ScriptRuntimeCheckpoint | null {
    return getDb().select().from(taskScriptRuntimes)
      .where(and(eq(taskScriptRuntimes.userId, userId), eq(taskScriptRuntimes.taskId, taskId))).get()?.checkpoint ?? null
  },
  save(userId: string, taskId: string, checkpoint: ScriptRuntimeCheckpoint): void {
    const task = getDb().select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt))).get()
    if (!task) throw new Error('The script task is no longer available.')
    getDb().insert(taskScriptRuntimes).values({ userId, taskId, checkpoint })
      .onConflictDoUpdate({ target: taskScriptRuntimes.taskId, set: { checkpoint } }).run()
  },
  list(userId?: string): { userId: string; taskId: string; checkpoint: ScriptRuntimeCheckpoint }[] {
    const query = getDb().select().from(taskScriptRuntimes)
    return userId === undefined ? query.all() : query.where(eq(taskScriptRuntimes.userId, userId)).all()
  },
  owner(userId: string, taskId: string): { taskId: string; checkpoint: ScriptRuntimeCheckpoint } | null {
    const own = this.get(userId, taskId)
    if (own) return { taskId, checkpoint: own }
    const child = getDb().select({ parent: tasks.parentTaskId }).from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId))).get()
    if (child?.parent) {
      const parent = this.get(userId, child.parent)
      if (parent && Object.values(parent.steps).some((step) => step.taskId === taskId)) return { taskId: child.parent, checkpoint: parent }
    }
    // Deletion notifications can arrive after the child's row was removed.
    return this.list(userId).find((row) => Object.values(row.checkpoint.steps).some((step) => step.taskId === taskId)) ?? null
  },
  info(userId: string, taskId: string, parentTaskId: string | null): TaskRuntimeInfo | null {
    const rootId = parentTaskId ?? taskId
    const saved = this.get(userId, rootId)
    if (!saved) return null
    const step = parentTaskId ? Object.values(saved.steps).find((value) => value.taskId === taskId) : null
    if (parentTaskId && !step) return null
    const state = step && ['completed', 'failed', 'canceled'].includes(step.state) ? 'completed'
      : saved.state === 'completed' || saved.state === 'interrupted' ? saved.state
      : step?.state === 'waiting' ? 'waiting' : step?.state === 'pending' ? 'queued' : saved.state
    return { state, reason: saved.reason, ownerTurns: saved.ownerTurns, elapsedMs: saved.elapsedMs,
      budget: saved.budget, controllerTaskId: rootId }
  }
}
