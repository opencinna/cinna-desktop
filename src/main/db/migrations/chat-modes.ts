import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

export function migrateChatModes(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'chat_modes')) {
    sqlite.exec(`
      CREATE TABLE chat_modes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        mcp_provider_ids TEXT DEFAULT '[]',
        color_preset TEXT NOT NULL DEFAULT 'slate',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `)
  }

  if (!hasColumn(sqlite, 'chat_modes', 'is_default')) {
    sqlite.exec(`ALTER TABLE chat_modes ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`)
  }
}
