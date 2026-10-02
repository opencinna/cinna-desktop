import type Database from 'better-sqlite3'

/**
 * Per-profile color preset of an agent: the sidebar icon, the chat-row dot and
 * the agent's chips take it (ids in `src/shared/agentColors.ts`).
 *
 * A table of its own rather than a column on `agent_overrides`: many readers
 * take `agentOverrideRepo.get(...)?.enabled ?? row.enabled`, so an override row
 * created only to hold a color would silently enable a disabled agent.
 *
 * No FK to `agents.id`, for the reason `agent_overrides` has none: sync may
 * drop and re-create a remote agent row with the same id, and the color must
 * survive that. A deleted user's rows are removed in
 * `userRepo.deleteWithCascade`. One color per agent; no row means None.
 */
export function migrateAgentColors(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_colors (
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      preset TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, agent_id)
    );
  `)
}
