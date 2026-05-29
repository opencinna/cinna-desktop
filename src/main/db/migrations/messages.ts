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

  if (!hasColumn(sqlite, 'messages', 'tool_agent_id')) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN tool_agent_id TEXT`)
  }

  if (!hasColumn(sqlite, 'messages', 'parts')) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN parts TEXT`)
  }

  if (!hasColumn(sqlite, 'messages', 'addressed_agent_id')) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN addressed_agent_id TEXT`)
  }

  // Smart Rewrite removed with the multi-agent switchboard — the orchestrator
  // authors each agent's message, so the pre-rewrite/rewritten text columns
  // are obsolete.
  if (hasColumn(sqlite, 'messages', 'rewritten_text')) {
    sqlite.exec(`ALTER TABLE messages DROP COLUMN rewritten_text`)
  }
  if (hasColumn(sqlite, 'messages', 'original_text')) {
    sqlite.exec(`ALTER TABLE messages DROP COLUMN original_text`)
  }

  if (!hasColumn(sqlite, 'messages', 'source_agent_id')) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN source_agent_id TEXT`)
  }

  if (!hasColumn(sqlite, 'messages', 'attachments')) {
    sqlite.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`)
  }
}
