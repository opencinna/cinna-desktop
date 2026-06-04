import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * Native Client Data Sync schema (plan §5). Idempotent — slotted into
 * `runMigrations()` AFTER the notes/jobs tables exist. No `sync_uuid` columns:
 * the existing `nanoid` PKs are used directly as `client_entity_id`.
 *
 *   sync_state      — per-profile cursor + E2E version + device id
 *   sync_device_key — per-install X25519 keypair (private key safeStorage-wrapped)
 *   sync_tombstone  — hard-delete signals (the codebase hard-deletes syncable rows)
 */
export function runSyncMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      user_id TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL DEFAULT 0,
      active_umk_version INTEGER NOT NULL DEFAULT 0,
      e2e_initialized_at INTEGER,
      last_pushed_at INTEGER,
      last_pulled_at INTEGER,
      device_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `)

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_device_key (
      user_id TEXT PRIMARY KEY,
      device_id TEXT,
      public_key TEXT NOT NULL,
      private_key_enc BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `)

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_tombstone (
      user_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      client_entity_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      pushed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, collection, client_entity_id)
    )
  `)

  // `disconnected` — this device opted OUT of online sync ("Disconnect online
  // sync"): its server device row was revoked and local enrollment torn down,
  // but the account stays initialized for other devices. The flag persists so
  // the device doesn't auto-reconcile/auto-unlock or nag to restore on relaunch;
  // it's cleared by an explicit "Connect".
  if (!hasColumn(sqlite, 'sync_state', 'disconnected')) {
    sqlite.exec('ALTER TABLE sync_state ADD COLUMN disconnected INTEGER NOT NULL DEFAULT 0')
  }
}
