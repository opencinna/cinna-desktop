import { and, sql, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { getDb } from './client'
import { localScheduleBindings, localScheduleOccurrences } from './schema'

export type ScheduleBindingRow = typeof localScheduleBindings.$inferSelect
export type ScheduleOccurrenceRow = typeof localScheduleOccurrences.$inferSelect

export const localScheduleRepo = {
  list(userId: string): ScheduleBindingRow[] {
    return getDb().select().from(localScheduleBindings).where(eq(localScheduleBindings.userId, userId)).all()
  },
  enabled(userId: string): ScheduleBindingRow[] {
    return getDb().select().from(localScheduleBindings).where(and(eq(localScheduleBindings.userId, userId), eq(localScheduleBindings.enabled, true))).all()
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
  history(userId: string, bindingId: string, offset: number, limit = 50): ScheduleOccurrenceRow[] {
    return getDb().select().from(localScheduleOccurrences).where(and(eq(localScheduleOccurrences.userId, userId), eq(localScheduleOccurrences.bindingId, bindingId)))
      .orderBy(desc(localScheduleOccurrences.utcMinute)).limit(limit).offset(offset).all()
  },
  observe(userId: string, id: string, watermark: number): void {
    getDb().update(localScheduleBindings).set({ watermark }).where(and(eq(localScheduleBindings.id, id), eq(localScheduleBindings.userId, userId), sql`${localScheduleBindings.watermark} < ${watermark}`)).run()
  },
  completed(userId: string, id: string, at: number): void {
    getDb().update(localScheduleBindings).set({ lastCompletedAt: at }).where(and(eq(localScheduleBindings.id, id), eq(localScheduleBindings.userId, userId),
      or(isNull(localScheduleBindings.lastCompletedAt), sql`${localScheduleBindings.lastCompletedAt} < ${at}`))).run()
  },
  claim(row: ScheduleBindingRow, nextDueAt: number, observedAt: number): boolean {
    return getDb().update(localScheduleBindings).set({ nextDueAt, watermark: Math.floor(observedAt / 60000), lastAttemptAt: observedAt, cursorVersion: row.cursorVersion + 1 })
      .where(and(eq(localScheduleBindings.id, row.id), eq(localScheduleBindings.userId, row.userId), eq(localScheduleBindings.enabled, true),
        eq(localScheduleBindings.revision, row.revision), eq(localScheduleBindings.cursorVersion, row.cursorVersion),
        sql`${localScheduleBindings.nextDueAt} = ${row.nextDueAt}`)).run().changes === 1
  },
  latest(userId: string, bindingId: string): ScheduleOccurrenceRow | undefined {
    return getDb().select().from(localScheduleOccurrences).where(and(eq(localScheduleOccurrences.userId, userId), eq(localScheduleOccurrences.bindingId, bindingId)))
      .orderBy(desc(localScheduleOccurrences.utcMinute)).limit(1).get()
  },
  unfinished(userId: string, bindingId: string): ScheduleOccurrenceRow[] {
    return getDb().select().from(localScheduleOccurrences).where(and(eq(localScheduleOccurrences.userId, userId),
      eq(localScheduleOccurrences.bindingId, bindingId), inArray(localScheduleOccurrences.status, ['prepared', 'dispatched', 'interrupted']))).all()
  },
  occurrence(userId: string, bindingId: string, civilKey: string): ScheduleOccurrenceRow | undefined {
    return getDb().select().from(localScheduleOccurrences).where(and(eq(localScheduleOccurrences.userId, userId),
      eq(localScheduleOccurrences.bindingId, bindingId), eq(localScheduleOccurrences.civilKey, civilKey))).get()
  },
  insertOccurrence(row: ScheduleOccurrenceRow): void {
    getDb().insert(localScheduleOccurrences).values(row).run()
  },
  /**
   * Settle the occurrences that launched `runId` from its outcome, and move
   * their bindings' `lastCompletedAt`. Returns how many rows changed.
   */
  settleByRun(userId: string, runId: string, patch: { status: 'completed' | 'failed' | 'cancelled'; reason: string | null; finishedAt: number }): number {
    const rows = getDb().select({ id: localScheduleOccurrences.id, bindingId: localScheduleOccurrences.bindingId }).from(localScheduleOccurrences)
      .where(and(eq(localScheduleOccurrences.userId, userId), eq(localScheduleOccurrences.runId, runId))).all()
    for (const row of rows) {
      this.updateOccurrence(userId, row.id, patch)
      this.completed(userId, row.bindingId, patch.finishedAt)
    }
    return rows.length
  },
  updateOccurrence(userId: string, id: string, patch: Partial<Omit<ScheduleOccurrenceRow, 'id' | 'userId' | 'bindingId'>>): void {
    getDb().update(localScheduleOccurrences).set(patch).where(and(eq(localScheduleOccurrences.userId, userId), eq(localScheduleOccurrences.id, id))).run()
  }
}
