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
  autoChatTitles: false,
  enableTrayIcon: true,
  showHints: true,
  prioritizeAccountDefaults: false,
  // Empty = the built-in default (`~/Documents/CinnaAgents`). Kept as a string
  // rather than `string | null` so `appSettingsService`'s typeof check works.
  localAgentsHome: '',
  // Empty = resolve one (PATH first, then the pinned managed download).
  localAgentsEnginePath: ''
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
      const parsed: unknown = JSON.parse(row.value)
      // The same type-drift rule {@link appSettingsRepo.getAll} applies, for the
      // same reason: the store is untyped at rest and the schema mixes types, so
      // a row whose value drifted from its key's type would otherwise be handed
      // to a caller that trusts the declared type. `configuredBinaryPath` in
      // `engineManager` defends itself against a non-string today, but that is
      // one caller remembering — and the two readers of the same store
      // disagreeing about what "corrupt" means is the drift worth closing.
      if (typeof parsed !== typeof DEFAULTS[key]) return DEFAULTS[key]
      return parsed as AppSettingsSchema[K]
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
      if (!Object.hasOwn(DEFAULTS, r.key)) continue
      const key = r.key as AppSettingKey
      try {
        const parsed: unknown = JSON.parse(r.value)
        // The store is untyped at rest and the schema now mixes types, so a row
        // whose value drifted from its key's type is dropped rather than handed
        // to a caller that trusts the declared type. Same rule
        // `appSettingsService` applies on the way in.
        if (typeof parsed !== typeof DEFAULTS[key]) continue
        // The write is type-erased on purpose: `out[key]` narrows to `never`
        // across a heterogeneous schema, and the typeof check above is what
        // actually makes it sound.
        ;(out as Record<AppSettingKey, unknown>)[key] = parsed
      } catch {
        /* keep default */
      }
    }
    return out
  }
}
