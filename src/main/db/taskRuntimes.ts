import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { taskRuntimes, tasks } from './schema'
import type { TaskRuntimeCheckpoint } from '../tasks/runtimeTypes'

export const taskRuntimeRepo = {
  get(userId: string, taskId: string): TaskRuntimeCheckpoint | null {
    return getDb().select().from(taskRuntimes)
      .where(and(eq(taskRuntimes.userId, userId), eq(taskRuntimes.taskId, taskId))).get()?.checkpoint ?? null
  },
  save(userId: string, taskId: string, checkpoint: TaskRuntimeCheckpoint): void {
    const task = getDb().select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt))).get()
    if (!task) throw new Error('The task is no longer available for local execution.')
    getDb().insert(taskRuntimes).values({ userId, taskId, checkpoint })
      .onConflictDoUpdate({ target: taskRuntimes.taskId, set: { checkpoint } }).run()
  },
  list(): { userId: string; taskId: string; checkpoint: TaskRuntimeCheckpoint }[] {
    return getDb().select().from(taskRuntimes).all()
  },
  remove(userId: string, taskId: string): void {
    getDb().delete(taskRuntimes).where(and(eq(taskRuntimes.userId, userId), eq(taskRuntimes.taskId, taskId))).run()
  }
}
