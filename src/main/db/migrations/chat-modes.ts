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

  // Runtime modes: Effort for every mode, and the engine a runtime mode stands for.
  if (!hasColumn(sqlite, 'chat_modes', 'complexity')) sqlite.exec('ALTER TABLE chat_modes ADD COLUMN complexity TEXT')
  if (!hasColumn(sqlite, 'chat_modes', 'builtin_engine')) sqlite.exec('ALTER TABLE chat_modes ADD COLUMN builtin_engine TEXT')
  migrateChatModeRuntimeIndex(sqlite)
}

/**
 * One runtime mode per user and engine: the partial unique index that makes
 * `ensureRuntimeModes` safe under concurrent calls. It needs `user_id`, which
 * the legacy backfill (`migrateUserIdColumns`) adds after this module runs on
 * an old database, so the migration index calls this again after that step.
 */
export function migrateChatModeRuntimeIndex(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'chat_modes') || !hasColumn(sqlite, 'chat_modes', 'user_id') || !hasColumn(sqlite, 'chat_modes', 'builtin_engine')) return
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS chat_modes_builtin_engine ON chat_modes(user_id, builtin_engine) WHERE builtin_engine IS NOT NULL')
}
