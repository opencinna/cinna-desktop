import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { appSettings } from './schema'
import type { AppSettingKey, AppSettingsSchema } from '../../shared/appSettings'

/**
 * Repo for the installation-global key/value settings store. The
 * {@link AppSettingsSchema} type lives in `shared/` so the preload and
 * renderer see the same shape; defaults are owned here so main-process
 * reads never depend on a row existing yet.
 *
 * Add a new toggle by adding a key in `shared/appSettings.ts` + a default
 * below. No migration needed: rows are created on first write.
 */

export const DEFAULTS: AppSettingsSchema = {
  autoChatTitles: false
}

export const appSettingsRepo = {
  get<K extends AppSettingKey>(key: K): AppSettingsSchema[K] {
    const row = getDb()
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get()
    if (!row) return DEFAULTS[key]
    try {
      return JSON.parse(row.value) as AppSettingsSchema[K]
    } catch {
      // Corrupt value — fall back to the default rather than crashing the
      // feature that asked for the setting.
      return DEFAULTS[key]
    }
  },

  set<K extends AppSettingKey>(key: K, value: AppSettingsSchema[K]): void {
    const serialized = JSON.stringify(value)
    getDb()
      .insert(appSettings)
      .values({ key, value: serialized, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: serialized, updatedAt: sql`(unixepoch())` }
      })
      .run()
  },

  /** Snapshot of every known key, applying defaults for any missing rows. */
  getAll(): AppSettingsSchema {
    const rows = getDb()
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .all()
    const out: AppSettingsSchema = { ...DEFAULTS }
    for (const r of rows) {
      if (!(r.key in DEFAULTS)) continue
      try {
        out[r.key as AppSettingKey] = JSON.parse(r.value)
      } catch {
        /* keep default */
      }
    }
    return out
  }
}
