import type Database from 'better-sqlite3'

/**
 * Stores per-profile enable/disable preferences for sync-managed (remote)
 * agents. Intentionally has no FK to `agents.id` and no ON DELETE CASCADE:
 * sync may remove and later re-create an agent row with the same id, and we
 * want the user's prior choice to survive that round-trip. Manual cleanup of
 * rows tied to a deleted user is done in `userRepo.deleteWithCascade`.
 */
export function migrateAgentOverrides(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_overrides (
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, agent_id)
    );
  `)
}
