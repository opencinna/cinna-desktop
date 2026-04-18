import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

export function migrateMessages(sqlite: Database.Database): void {
  sqlite.exec(`
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

  if (!hasColumn(sqlite, 'messages', 'tool_calls')) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN tool_calls TEXT`)
    sqlite.exec(`ALTER TABLE messages ADD COLUMN tool_error INTEGER`)
    sqlite.exec(`UPDATE messages SET role = 'tool_call' WHERE role = 'tool'`)
  }

  if (!hasColumn(sqlite, 'messages', 'tool_provider')) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN tool_provider TEXT`)
  }

  if (!hasColumn(sqlite, 'messages', 'parts')) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN parts TEXT`)
  }
}
