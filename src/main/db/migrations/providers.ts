import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

export function migrateProviders(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      api_key_enc BLOB,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `)

  if (!hasColumn(sqlite, 'llm_providers', 'is_default')) {
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`)
  }

  if (!hasColumn(sqlite, 'llm_providers', 'default_model_id')) {
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN default_model_id TEXT`)
  }
}
