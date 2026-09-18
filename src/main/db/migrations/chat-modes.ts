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

  if (!hasColumn(sqlite, 'chat_modes', 'engine')) {
    sqlite.exec('ALTER TABLE chat_modes ADD COLUMN engine TEXT')
    sqlite.exec("UPDATE chat_modes SET engine = 'opencode' WHERE provider_id IS NOT NULL")
  }
  if (!hasColumn(sqlite, 'chat_modes', 'system_prompt')) sqlite.exec("ALTER TABLE chat_modes ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''")
  if (!hasColumn(sqlite, 'chat_modes', 'tool_policy')) sqlite.exec("ALTER TABLE chat_modes ADD COLUMN tool_policy TEXT NOT NULL DEFAULT 'connectors'")

  if (!hasColumn(sqlite, 'chat_modes', 'is_default')) {
    sqlite.exec(`ALTER TABLE chat_modes ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`)
  }
}
