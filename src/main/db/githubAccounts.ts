import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { appSettings } from './schema'

/**
 * Each Cinna profile's OpenCinna GitHub sign-in (guest included): one keystore-encrypted JSON blob,
 * stored base64 in the installation-global `app_settings` table under a key that is not an
 * `AppSettingsSchema` key (as `addonPolicies.ts` does), so `appSettingsRepo.getAll` never surfaces it
 * and no settings channel can write it. `userRepo.deleteWithCascade` removes it with the profile.
 */
export const GITHUB_ACCOUNT_KEY_PREFIX = '__github:'

export const githubAccountRepo = {
  /** The encrypted blob, base64, or null. */
  read(userId: string): string | null {
    const row = getDb()
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, `${GITHUB_ACCOUNT_KEY_PREFIX}${userId}`))
      .get()
    return typeof row?.value === 'string' ? row.value : null
  },

  write(userId: string, value: string): void {
    getDb()
      .insert(appSettings)
      .values({ key: `${GITHUB_ACCOUNT_KEY_PREFIX}${userId}`, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: sql`(unixepoch())` } })
      .run()
  },

  remove(userId: string): void {
    getDb().delete(appSettings).where(eq(appSettings.key, `${GITHUB_ACCOUNT_KEY_PREFIX}${userId}`)).run()
  }
}
