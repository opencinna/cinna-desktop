import { eq, like, sql } from 'drizzle-orm'
import { getDb } from './client'
import { appSettings } from './schema'

/**
 * Which profile each Cinna account key was last derived for, and how it was named then, so an
 * agent whose credentials come from an account that cannot supply them now (signed out, locked,
 * tokens gone, profile deleted) can still name it: once its tokens are gone the key cannot be
 * re-derived, and a deleted profile has no row left to read.
 *
 * Rows of the installation-global `app_settings` table under a key that is not an
 * `AppSettingsSchema` key (as `addonPolicies.ts` does), so `appSettingsRepo.getAll` never
 * surfaces them and no settings channel can write them. Main-only: no channel reads them as such.
 */

const KEY_PREFIX = '__credentialAccount:'

export interface CredentialAccountRecord {
  userId: string
  name: string
  email: string
  serverUrl: string
}

function parse(value: string): CredentialAccountRecord | null {
  try {
    const v = JSON.parse(value) as Partial<CredentialAccountRecord>
    return typeof v.userId === 'string' && typeof v.name === 'string' && typeof v.email === 'string' && typeof v.serverUrl === 'string'
      ? { userId: v.userId, name: v.name, email: v.email, serverUrl: v.serverUrl }
      : null
  } catch {
    return null
  }
}

export const credentialAccountRepo = {
  /** Every recorded account key with its profile. Malformed rows are skipped. */
  list(): Map<string, CredentialAccountRecord> {
    const rows = getDb()
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(like(appSettings.key, `${KEY_PREFIX}%`))
      .all()
    const out = new Map<string, CredentialAccountRecord>()
    for (const row of rows) {
      // `_` is a LIKE wildcard: the prefix is checked again exactly.
      if (!row.key.startsWith(KEY_PREFIX)) continue
      const record = parse(row.value)
      if (record) out.set(row.key.slice(KEY_PREFIX.length), record)
    }
    return out
  },

  set(accountKey: string, record: CredentialAccountRecord): void {
    const serialized = JSON.stringify(record)
    getDb()
      .insert(appSettings)
      .values({ key: `${KEY_PREFIX}${accountKey}`, value: serialized, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized, updatedAt: sql`(unixepoch())` } })
      .run()
  },

  /** Forget an account key's name: kept only while some agent's attachments are stored under it. */
  remove(accountKey: string): void {
    getDb().delete(appSettings).where(eq(appSettings.key, `${KEY_PREFIX}${accountKey}`)).run()
  }
}

/**
 * What a slot is matched by, per Core record an agent attached under an account (`type`,
 * `serviceUri`, `name`), so a slot that account's record fills still reads as held once the
 * profile's cache is gone (a logout clears it). Keyed by account key, then by Core's record id.
 * Main-only, like the map above: the scanner matches slots by it, and the renderer only ever
 * sees a held slot's `account_unavailable` state, never these names or types.
 */
const REFS_PREFIX = '__credentialAccountRefs:'

export interface CredentialRefRecord {
  type: string
  serviceUri: string | null
  name: string
}

function parseRefs(value: string): Map<string, CredentialRefRecord> {
  const out = new Map<string, CredentialRefRecord>()
  try {
    const v = JSON.parse(value) as Record<string, Partial<CredentialRefRecord>>
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out
    for (const [ref, r] of Object.entries(v)) {
      if (r && typeof r.type === 'string' && typeof r.name === 'string' && (r.serviceUri === null || typeof r.serviceUri === 'string')) {
        out.set(ref, { type: r.type, serviceUri: r.serviceUri, name: r.name })
      }
    }
  } catch {
    // A malformed row matches nothing.
  }
  return out
}

export const credentialRefRepo = {
  /** Every account key's recorded references. Malformed rows and entries are skipped. */
  list(): Map<string, Map<string, CredentialRefRecord>> {
    const rows = getDb()
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(like(appSettings.key, `${REFS_PREFIX}%`))
      .all()
    const out = new Map<string, Map<string, CredentialRefRecord>>()
    for (const row of rows) {
      if (!row.key.startsWith(REFS_PREFIX)) continue
      out.set(row.key.slice(REFS_PREFIX.length), parseRefs(row.value))
    }
    return out
  },

  /** Replace one account key's references; an empty map removes its row. */
  set(accountKey: string, refs: ReadonlyMap<string, CredentialRefRecord>): void {
    const key = `${REFS_PREFIX}${accountKey}`
    if (refs.size === 0) {
      getDb().delete(appSettings).where(eq(appSettings.key, key)).run()
      return
    }
    const serialized = JSON.stringify(Object.fromEntries(refs))
    getDb()
      .insert(appSettings)
      .values({ key, value: serialized, updatedAt: new Date() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized, updatedAt: sql`(unixepoch())` } })
      .run()
  }
}
