import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

let db: BetterSQLite3Database<typeof schema>
let sqlite: Database.Database

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'cinna.db')
  sqlite = new Database(dbPath)

  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  db = drizzle(sqlite, { schema })

  runMigrations()
}

function runMigrations(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      api_key_enc BLOB,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport_type TEXT NOT NULL,
      command TEXT,
      args TEXT,
      url TEXT,
      env TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      model_id TEXT,
      provider_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_mcp_providers (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      mcp_provider_id TEXT NOT NULL REFERENCES mcp_providers(id) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, mcp_provider_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_input TEXT,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sort_order ON messages(chat_id, sort_order);
  `)

  // Migration: add is_default column to llm_providers
  const hasIsDefault = sqlite
    .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('llm_providers') WHERE name='is_default'")
    .get() as { cnt: number }
  if (hasIsDefault.cnt === 0) {
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`)
  }

  // Migration: add default_model_id column to llm_providers
  const hasDefaultModelId = sqlite
    .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('llm_providers') WHERE name='default_model_id'")
    .get() as { cnt: number }
  if (hasDefaultModelId.cnt === 0) {
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN default_model_id TEXT`)
  }

  // Migration: add auth_tokens_enc and client_info columns to mcp_providers
  const hasAuthTokens = sqlite
    .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('mcp_providers') WHERE name='auth_tokens_enc'")
    .get() as { cnt: number }
  if (hasAuthTokens.cnt === 0) {
    sqlite.exec(`ALTER TABLE mcp_providers ADD COLUMN auth_tokens_enc BLOB`)
    sqlite.exec(`ALTER TABLE mcp_providers ADD COLUMN client_info TEXT`)
  }

  // Migration: add tool_calls and tool_error columns to messages, rename role 'tool' -> 'tool_call'
  const hasToolCalls = sqlite
    .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('messages') WHERE name='tool_calls'")
    .get() as { cnt: number }
  if (hasToolCalls.cnt === 0) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN tool_calls TEXT`)
    sqlite.exec(`ALTER TABLE messages ADD COLUMN tool_error INTEGER`)
    sqlite.exec(`UPDATE messages SET role = 'tool_call' WHERE role = 'tool'`)
  }

  // Migration: add tool_provider column to messages
  const hasToolProvider = sqlite
    .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('messages') WHERE name='tool_provider'")
    .get() as { cnt: number }
  if (hasToolProvider.cnt === 0) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN tool_provider TEXT`)
  }
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return db
}
