import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { managedOverrides } from './schema'

export type ManagedOverrideKind = 'provider' | 'mode'

export interface ManagedOverrideRow {
  userId: string
  kind: ManagedOverrideKind
  resourceId: string
  enabled: boolean
}

/**
 * Per-profile enable/disable preference for account-provisioned (Cinna-managed)
 * providers and chat modes. Sync owns the resource rows; this table holds the
 * user's local on/off choice so it survives re-sync — directly mirroring
 * `agentOverrideRepo`.
 */
export const managedOverrideRepo = {
  /** All overrides for a profile, as a `${kind}:${resourceId}` → enabled map. */
  map(userId: string): Map<string, boolean> {
    const rows = getDb()
      .select()
      .from(managedOverrides)
      .where(eq(managedOverrides.userId, userId))
      .all()
    const out = new Map<string, boolean>()
    for (const r of rows) out.set(`${r.kind}:${r.resourceId}`, r.enabled)
    return out
  },

  /** Upsert a single override (composite PK on userId+kind+resourceId). */
  set(userId: string, kind: ManagedOverrideKind, resourceId: string, enabled: boolean): void {
    getDb()
      .insert(managedOverrides)
      .values({ userId, kind, resourceId, enabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [managedOverrides.userId, managedOverrides.kind, managedOverrides.resourceId],
        set: { enabled, updatedAt: new Date() }
      })
      .run()
  },

  /** Remove every override owned by a user (used by deleteWithCascade). */
  deleteForUser(userId: string): void {
    getDb().delete(managedOverrides).where(eq(managedOverrides.userId, userId)).run()
  },

  /** Read a single effective preference; defaults to enabled when unset. */
  isEnabled(userId: string, kind: ManagedOverrideKind, resourceId: string): boolean {
    const row = getDb()
      .select()
      .from(managedOverrides)
      .where(
        and(
          eq(managedOverrides.userId, userId),
          eq(managedOverrides.kind, kind),
          eq(managedOverrides.resourceId, resourceId)
        )
      )
      .get()
    return row?.enabled ?? true
  }
}
