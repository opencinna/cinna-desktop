import { getRawSqlite } from './client'
import type { SyncCollection } from '../../shared/sync'

/**
 * Raw-SQL repo for the sync bookkeeping tables (`sync_state`,
 * `sync_device_key`, `sync_tombstone`). These tables are created by
 * `runSyncMigrations` and kept out of the Drizzle schema — they are
 * main-process-only plumbing and never read by the renderer directly.
 */

export interface SyncStateRow {
  userId: string
  cursor: number
  activeUmkVersion: number
  e2eInitializedAt: number | null
  lastPushedAt: number | null
  lastPulledAt: number | null
  deviceId: string | null
  updatedAt: number
}

export interface DeviceKeyRow {
  userId: string
  deviceId: string | null
  publicKey: string
  privateKeyEnc: Buffer
  createdAt: number
}

export interface TombstoneRow {
  userId: string
  collection: SyncCollection
  clientEntityId: string
  deletedAt: number
}

export const syncRepo = {
  // ---- sync_state ----

  getState(userId: string): SyncStateRow | null {
    const row = getRawSqlite()
      .prepare(`SELECT * FROM sync_state WHERE user_id = ?`)
      .get(userId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      userId: row.user_id as string,
      cursor: (row.cursor as number) ?? 0,
      activeUmkVersion: (row.active_umk_version as number) ?? 0,
      e2eInitializedAt: (row.e2e_initialized_at as number) ?? null,
      lastPushedAt: (row.last_pushed_at as number) ?? null,
      lastPulledAt: (row.last_pulled_at as number) ?? null,
      deviceId: (row.device_id as string) ?? null,
      updatedAt: (row.updated_at as number) ?? 0
    }
  },

  ensureState(userId: string): SyncStateRow {
    const existing = this.getState(userId)
    if (existing) return existing
    getRawSqlite()
      .prepare(
        `INSERT OR IGNORE INTO sync_state (user_id, cursor, active_umk_version, updated_at)
         VALUES (?, 0, 0, strftime('%s','now'))`
      )
      .run(userId)
    return this.getState(userId)!
  },

  patchState(
    userId: string,
    patch: Partial<Omit<SyncStateRow, 'userId' | 'updatedAt'>>
  ): void {
    this.ensureState(userId)
    const cols: string[] = []
    const vals: unknown[] = []
    const map: Record<string, string> = {
      cursor: 'cursor',
      activeUmkVersion: 'active_umk_version',
      e2eInitializedAt: 'e2e_initialized_at',
      lastPushedAt: 'last_pushed_at',
      lastPulledAt: 'last_pulled_at',
      deviceId: 'device_id'
    }
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k]
      if (!col) continue
      cols.push(`${col} = ?`)
      vals.push(v)
    }
    if (!cols.length) return
    cols.push(`updated_at = strftime('%s','now')`)
    vals.push(userId)
    getRawSqlite()
      .prepare(`UPDATE sync_state SET ${cols.join(', ')} WHERE user_id = ?`)
      .run(...vals)
  },

  // ---- sync_device_key ----

  getDeviceKey(userId: string): DeviceKeyRow | null {
    const row = getRawSqlite()
      .prepare(`SELECT * FROM sync_device_key WHERE user_id = ?`)
      .get(userId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      userId: row.user_id as string,
      deviceId: (row.device_id as string) ?? null,
      publicKey: row.public_key as string,
      privateKeyEnc: row.private_key_enc as Buffer,
      createdAt: (row.created_at as number) ?? 0
    }
  },

  saveDeviceKey(input: {
    userId: string
    deviceId: string | null
    publicKey: string
    privateKeyEnc: Buffer
  }): void {
    getRawSqlite()
      .prepare(
        `INSERT INTO sync_device_key (user_id, device_id, public_key, private_key_enc, created_at)
         VALUES (?, ?, ?, ?, strftime('%s','now'))
         ON CONFLICT(user_id) DO UPDATE SET
           device_id = excluded.device_id,
           public_key = excluded.public_key,
           private_key_enc = excluded.private_key_enc`
      )
      .run(input.userId, input.deviceId, input.publicKey, input.privateKeyEnc)
  },

  setDeviceId(userId: string, deviceId: string): void {
    getRawSqlite()
      .prepare(`UPDATE sync_device_key SET device_id = ? WHERE user_id = ?`)
      .run(deviceId, userId)
  },

  /** Drop this device's keypair — used by the "remove device" sign-out path so
   *  the next login can no longer silently unwrap the UMK (needs recovery/pairing). */
  deleteDeviceKey(userId: string): void {
    getRawSqlite().prepare(`DELETE FROM sync_device_key WHERE user_id = ?`).run(userId)
  },

  /** Drop the local sync bookkeeping row entirely (remove-device sign-out).
   *  Init state then re-derives from the server on next activation. */
  deleteState(userId: string): void {
    getRawSqlite().prepare(`DELETE FROM sync_state WHERE user_id = ?`).run(userId)
  },

  // ---- sync_tombstone ----

  addTombstone(
    userId: string,
    collection: SyncCollection,
    clientEntityId: string,
    deletedAt: number
  ): void {
    getRawSqlite()
      .prepare(
        `INSERT INTO sync_tombstone (user_id, collection, client_entity_id, deleted_at, pushed)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(user_id, collection, client_entity_id) DO UPDATE SET
           deleted_at = excluded.deleted_at, pushed = 0`
      )
      .run(userId, collection, clientEntityId, deletedAt)
  },

  listUnpushedTombstones(userId: string): TombstoneRow[] {
    const rows = getRawSqlite()
      .prepare(
        `SELECT collection, client_entity_id, deleted_at
         FROM sync_tombstone WHERE user_id = ? AND pushed = 0`
      )
      .all(userId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      userId,
      collection: r.collection as SyncCollection,
      clientEntityId: r.client_entity_id as string,
      deletedAt: r.deleted_at as number
    }))
  },

  markTombstonePushed(userId: string, collection: SyncCollection, clientEntityId: string): void {
    getRawSqlite()
      .prepare(
        `UPDATE sync_tombstone SET pushed = 1
         WHERE user_id = ? AND collection = ? AND client_entity_id = ?`
      )
      .run(userId, collection, clientEntityId)
  },

  /** Reset all sync state for a profile (used by "delete synced data"). */
  wipe(userId: string): void {
    const db = getRawSqlite()
    db.prepare(`DELETE FROM sync_tombstone WHERE user_id = ?`).run(userId)
    db.prepare(`UPDATE sync_state SET cursor = 0, last_pushed_at = NULL, last_pulled_at = NULL WHERE user_id = ?`).run(
      userId
    )
  }
}
