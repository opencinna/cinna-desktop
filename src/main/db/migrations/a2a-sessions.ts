import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

export function migrateA2aSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS a2a_sessions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      context_id TEXT,
      task_id TEXT,
      task_state TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS managed_agent_sessions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      binding TEXT NOT NULL,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, agent_id)
    );
  `)
  // The acknowledged id of the turn's `user.message`: relaunch recovery
  // follows the session from it. Null for a turn that never got that far.
  if (!hasColumn(sqlite, 'managed_agent_sessions', 'kickoff_event_id')) {
    sqlite.exec('ALTER TABLE managed_agent_sessions ADD COLUMN kickoff_event_id TEXT')
  }
  // The chat's user row that kickoff answers, so a kickoff is followed only
  // for its own turn.
  if (!hasColumn(sqlite, 'managed_agent_sessions', 'kickoff_message_id')) {
    sqlite.exec('ALTER TABLE managed_agent_sessions ADD COLUMN kickoff_message_id TEXT')
  }
}
