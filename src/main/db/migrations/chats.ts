import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

export function migrateChats(sqlite: Database.Database): void {
  sqlite.exec(`
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
  `)

  if (!hasColumn(sqlite, 'chats', 'deleted_at')) {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN deleted_at INTEGER`)
  }

  if (!hasColumn(sqlite, 'chats', 'mode_id')) {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN mode_id TEXT`)
  }

  if (!hasColumn(sqlite, 'chats', 'agent_id')) {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN agent_id TEXT`)
  }

  // Cleanup: permanently delete chats that have been in trash for over 30 days
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  sqlite.exec(`DELETE FROM chats WHERE deleted_at IS NOT NULL AND deleted_at < ${thirtyDaysAgo}`)
}
