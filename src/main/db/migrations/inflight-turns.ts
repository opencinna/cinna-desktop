import type Database from 'better-sqlite3'

/**
 * `inflight_turns`: one row per direct-chat agent turn that is running, written
 * when the turn starts and deleted on every ending. A row found at boot is a
 * turn the app was killed under — see `interruptedTurnService`.
 *
 * `draft_message_id` names the assistant row the turn keeps up to date while
 * it runs, so a kill leaves what had streamed. No FK on it: the row is deleted
 * and replaced by the turn's final rows, and the marker only ever points at it.
 */
export function migrateInflightTurns(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inflight_turns (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      user_message_id TEXT,
      draft_message_id TEXT,
      started_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inflight_turns_chat ON inflight_turns(chat_id);
  `)
}
