import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { managedOverrides } from './schema'

export type ManagedOverrideKind = 'provider' | 'mode'

export interface ManagedOverrideRow {
  userId: string
  kind: ManagedOverrideKind
  resourceId: string
  enabled: boolean
  /** Per-mode model choice overriding the synced default (null = use default). */
  modelId: string | null
}

/** Effective local preferences for one managed resource. */
export interface ManagedOverride {
  enabled: boolean
  modelId: string | null
}

/**
 * Per-profile enable/disable preference for account-provisioned (Cinna-managed)
 * providers and chat modes. Sync owns the resource rows; this table holds the
 * user's local on/off choice so it survives re-sync — directly mirroring
 * `agentOverrideRepo`.
 */
export const managedOverrideRepo = {
  /**
   * All overrides for a profile, as a `${kind}:${resourceId}` → preferences map.
   * Holds both the enable flag and the model choice so a single read backs both
   * overlays in `chatModeService.listMerged`.
   */
  map(userId: string): Map<string, ManagedOverride> {
    const rows = getDb()
      .select()
      .from(managedOverrides)
      .where(eq(managedOverrides.userId, userId))
      .all()
    const out = new Map<string, ManagedOverride>()
    for (const r of rows) {
      out.set(`${r.kind}:${r.resourceId}`, { enabled: r.enabled, modelId: r.modelId })
    }
    return out
  },

  /**
   * Upsert the enable flag (composite PK on userId+kind+resourceId). Leaves any
   * existing `model_id` untouched — the two preferences share a row but are set
   * independently.
   */
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

  /**
   * Upsert the model override (null clears it → revert to the synced default).
   * A new row defaults `enabled` to true; an existing row's enable flag is left
   * untouched.
   */
  setModel(
    userId: string,
    kind: ManagedOverrideKind,
    resourceId: string,
    modelId: string | null
  ): void {
    getDb()
      .insert(managedOverrides)
      .values({ userId, kind, resourceId, enabled: true, modelId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [managedOverrides.userId, managedOverrides.kind, managedOverrides.resourceId],
        set: { modelId, updatedAt: new Date() }
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
  },

  /** Read a single resource's model override; null when unset (use the default). */
  getModel(userId: string, kind: ManagedOverrideKind, resourceId: string): string | null {
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
    return row?.modelId ?? null
  }
}
