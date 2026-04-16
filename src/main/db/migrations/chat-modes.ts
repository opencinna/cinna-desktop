import type Database from 'better-sqlite3'
import { hasTable } from './helpers'

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
        created_at INTEGER NOT NULL
      )
    `)
  }
}
