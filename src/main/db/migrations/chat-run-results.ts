import type Database from 'better-sqlite3'

export function migrateChatRunResults(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS chat_run_results (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    unread INTEGER NOT NULL DEFAULT 1
  )`)
}
