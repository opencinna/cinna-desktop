import type Database from 'better-sqlite3'

export function migrateConductorSessions(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS conductor_sessions (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    descriptor_hash TEXT NOT NULL,
    PRIMARY KEY (chat_id, agent_id)
  )`)
}
