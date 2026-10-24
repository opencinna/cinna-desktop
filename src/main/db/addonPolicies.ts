import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { appSettings } from './schema'

/**
 * The last addon `policy` core sent, per Cinna account (`<profile>@<origin>`),
 * kept so a restart with core unreachable applies it rather than allowing
 * everything (`services/addonDirectory/policy.ts`). Rows of the
 * installation-global `app_settings` table under a key that is not an
 * `AppSettingsSchema` key, so `appSettingsRepo.getAll` never surfaces them and
 * no settings channel can write them. The value is the policy as JSON,
 * unvalidated here: the reader checks every flag.
 */

const KEY_PREFIX = '__addonPolicy:'

export const addonPolicyRepo = {
  get(account: string): unknown {
    const row = getDb()
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, `${KEY_PREFIX}${account}`))
      .get()
    if (!row) return null
    try {
      return JSON.parse(row.value) as unknown
    } catch {
      return null
    }
  },

  set(account: string, policy: unknown): void {
    const serialized = JSON.stringify(policy)
    getDb()
      .insert(appSettings)
      .values({ key: `${KEY_PREFIX}${account}`, value: serialized, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized, updatedAt: sql`(unixepoch())` } })
      .run()
  }
}
