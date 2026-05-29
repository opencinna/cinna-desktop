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

    CREATE TABLE IF NOT EXISTS chat_on_demand_mcps (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      mcp_provider_id TEXT NOT NULL REFERENCES mcp_providers(id) ON DELETE CASCADE,
      pending_announce INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, mcp_provider_id)
    );

    CREATE TABLE IF NOT EXISTS chat_on_demand_agents (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      pending_announce INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, agent_id)
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

  if (!hasColumn(sqlite, 'chats', 'orchestrated')) {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN orchestrated INTEGER NOT NULL DEFAULT 0`)
  }

  // Multi-agent switchboard removed: agents-as-tools orchestration is now the
  // only multi-counterparty engine, so the per-chat active-agent target, the
  // Smart Rewrite toggle, and the catch-up cursor table are all obsolete.
  if (hasColumn(sqlite, 'chats', 'active_agent_id')) {
    sqlite.exec(`ALTER TABLE chats DROP COLUMN active_agent_id`)
  }
  if (hasColumn(sqlite, 'chats', 'smart_assist_disabled')) {
    sqlite.exec(`ALTER TABLE chats DROP COLUMN smart_assist_disabled`)
  }
  sqlite.exec(`DROP TABLE IF EXISTS chat_agent_sessions`)

  // Cleanup: permanently delete chats that have been in trash for over 30 days.
  // `deleted_at` is stored as Unix seconds (drizzle's `mode: 'timestamp'`), so
  // we must compare against seconds — using `Date.now()` directly would wipe
  // every trashed chat on the next startup (ms value >> any second-scaled row).
  const thirtyDaysAgoSeconds = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000)
  sqlite.exec(
    `DELETE FROM chats WHERE deleted_at IS NOT NULL AND deleted_at < ${thirtyDaysAgoSeconds}`
  )
}
