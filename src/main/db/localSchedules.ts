import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { getDb } from './client'
import { jobRuns, tasks, localScheduleBindings, localScheduleOccurrences } from './schema'

export type ScheduleBindingRow = typeof localScheduleBindings.$inferSelect
export type ScheduleOccurrenceRow = typeof localScheduleOccurrences.$inferSelect

export const localScheduleRepo = {
  list(userId: string): ScheduleBindingRow[] {
    return getDb().select().from(localScheduleBindings).where(eq(localScheduleBindings.userId, userId)).all()
  },
  get(userId: string, id: string): ScheduleBindingRow | undefined {
    return getDb().select().from(localScheduleBindings).where(and(eq(localScheduleBindings.userId, userId), eq(localScheduleBindings.id, id))).get()
  },
  save(row: ScheduleBindingRow): void {
    getDb().insert(localScheduleBindings).values(row).onConflictDoUpdate({ target: localScheduleBindings.id, set: row }).run()
  },
  occurrences(userId: string, bindingId: string): ScheduleOccurrenceRow[] {
    return getDb().select().from(localScheduleOccurrences).where(and(eq(localScheduleOccurrences.userId, userId), eq(localScheduleOccurrences.bindingId, bindingId)))
      .orderBy(desc(localScheduleOccurrences.utcMinute)).all()
  },
  latest(userId: string, bindingId: string): ScheduleOccurrenceRow | undefined {
    return getDb().select().from(localScheduleOccurrences).where(and(eq(localScheduleOccurrences.userId, userId), eq(localScheduleOccurrences.bindingId, bindingId)))
      .orderBy(desc(localScheduleOccurrences.utcMinute)).limit(1).get()
  },
  unfinished(userId: string, bindingId: string): ScheduleOccurrenceRow[] {
    return getDb().select().from(localScheduleOccurrences).where(and(eq(localScheduleOccurrences.userId, userId),
      eq(localScheduleOccurrences.bindingId, bindingId), inArray(localScheduleOccurrences.status, ['prepared', 'dispatched', 'interrupted']))).all()
  },
  unfinishedRuns(userId: string, jobIds: string[]): { taskId: string | null }[] {
    if (!jobIds.length) return []
    return getDb().select({ taskId: jobRuns.taskId }).from(jobRuns).leftJoin(tasks, eq(tasks.id, jobRuns.taskId))
      .where(and(eq(jobRuns.userId, userId), inArray(jobRuns.jobId, jobIds), isNull(tasks.deletedAt), or(inArray(jobRuns.status, ['pending', 'running']),
        inArray(tasks.status, ['new', 'open', 'in_progress', 'blocked'])))).limit(1).all()
  },
  occurrence(userId: string, bindingId: string, civilKey: string): ScheduleOccurrenceRow | undefined {
    return getDb().select().from(localScheduleOccurrences).where(and(eq(localScheduleOccurrences.userId, userId),
      eq(localScheduleOccurrences.bindingId, bindingId), eq(localScheduleOccurrences.civilKey, civilKey))).get()
  },
  insertOccurrence(row: ScheduleOccurrenceRow): void {
    getDb().insert(localScheduleOccurrences).values(row).run()
  },
  updateOccurrence(userId: string, id: string, patch: Partial<Pick<ScheduleOccurrenceRow, 'status' | 'reason' | 'taskId' | 'runId' | 'chatId'>>): void {
    getDb().update(localScheduleOccurrences).set(patch).where(and(eq(localScheduleOccurrences.userId, userId), eq(localScheduleOccurrences.id, id))).run()
  }
}
