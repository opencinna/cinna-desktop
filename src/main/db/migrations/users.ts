import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

export function migrateUsers(sqlite: Database.Database): void {
  // Create users table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'local_user',
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT,
      salt TEXT,
      created_at INTEGER NOT NULL
    );
  `)

  // Insert default user if not exists
  const defaultUser = sqlite
    .prepare(`SELECT id FROM users WHERE id = '__default__'`)
    .get()

  if (!defaultUser) {
    sqlite
      .prepare(
        `INSERT INTO users (id, type, username, display_name, password_hash, salt, created_at)
         VALUES ('__default__', 'local_user', 'default', 'Unknown Entity', NULL, NULL, ?)`
      )
      .run(Date.now())
  }

  // Add type column if missing (upgrade path)
  if (!hasColumn(sqlite, 'users', 'type')) {
    sqlite.exec(`ALTER TABLE users ADD COLUMN type TEXT NOT NULL DEFAULT 'local_user'`)
  }

  // Cinna account columns
  const cinnaColumns: [string, string][] = [
    ['cinna_full_name', 'TEXT'],
    ['cinna_server_url', 'TEXT'],
    ['cinna_hosting_type', 'TEXT'],
    ['cinna_client_id', 'TEXT'],
    ['cinna_access_token_enc', 'BLOB'],
    ['cinna_refresh_token_enc', 'BLOB'],
    ['cinna_token_expires_at', 'INTEGER']
  ]
  for (const [col, type] of cinnaColumns) {
    if (!hasColumn(sqlite, 'users', col)) {
      sqlite.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`)
    }
  }
}

/**
 * Backfill the `user_id` column on legacy data tables that predate the
 * multi-user refactor. Must run AFTER the table-creation migrations — on a
 * fresh install these tables don't exist yet when `migrateUsers` runs, and
 * `hasTable` keeps us from issuing ALTERs against missing tables.
 */
export function migrateUserIdColumns(sqlite: Database.Database): void {
  const tables = ['llm_providers', 'mcp_providers', 'chats', 'chat_modes', 'agents']
  for (const table of tables) {
    if (!hasTable(sqlite, table)) continue
    if (!hasColumn(sqlite, table, 'user_id')) {
      sqlite.exec(
        `ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT '__default__'`
      )
    }
  }
}
