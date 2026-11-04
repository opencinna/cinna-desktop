import { isNull, sql } from 'drizzle-orm'
import { getDb } from './client'
import { dashboards, notes } from './schema'

/**
 * Whether this installation already holds records of an optional capability,
 * across **every** profile. The capability settings are installation-global,
 * so the first-run decision (`capabilityService`) must not be judged on the
 * one profile that happens to be active: a user whose notes live in another
 * profile would otherwise have Notes written off.
 *
 * Deliberately unscoped — the only reads in `db/` that are. They answer a
 * count and nothing else, so no profile's content leaves this file.
 */
export const capabilityCountsRepo = {
  /** Notes not in the trash, in any profile. */
  notes(): number {
    const row = getDb().select({ n: sql<number>`count(*)` }).from(notes).where(isNull(notes.deletedAt)).get()
    return Number(row?.n ?? 0)
  },

  /** Dashboards in any profile. */
  dashboards(): number {
    const row = getDb().select({ n: sql<number>`count(*)` }).from(dashboards).get()
    return Number(row?.n ?? 0)
  }
}
