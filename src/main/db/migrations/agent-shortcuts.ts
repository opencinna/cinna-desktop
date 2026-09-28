import type Database from 'better-sqlite3'

/**
 * Per-profile ⌘1–⌘9 bindings: which agent a digit starts a chat with.
 *
 * A table of its own rather than a column on `agent_overrides`: many readers
 * take `agentOverrideRepo.get(...)?.enabled ?? row.enabled`, so an override row
 * created only to hold a shortcut would silently enable a disabled agent.
 *
 * No FK to `agents.id`, for the reason `agent_overrides` has none: sync may
 * drop and re-create a remote agent row with the same id, and the binding must
 * survive that. A deleted user's rows are removed in
 * `userRepo.deleteWithCascade`. One digit per agent and one agent per digit.
 */
export function migrateAgentShortcuts(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_shortcuts (
      user_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, slot),
      UNIQUE (user_id, agent_id)
    );
  `)
}
