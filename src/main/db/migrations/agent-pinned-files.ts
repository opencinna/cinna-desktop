import type Database from 'better-sqlite3'

/**
 * Files a profile pinned for an agent: the chat's Pinned files card lists them
 * in every chat with that agent.
 *
 * `path` is relative to the agent folder when `inside` is 1, so a moved agent
 * folder keeps its inside pins; absolute otherwise. `rank` orders the list
 * (fractional, a drag writes a value between its neighbours).
 *
 * No FK to `agents.id`, for the reason `agent_colors` has none: sync may drop
 * and re-create an agent row with the same id. A deleted user's rows are
 * removed in `userRepo.deleteWithCascade`, a re-keyed agent's follow it in
 * `agentRepo.rekeyFolderRow`.
 */
export function migrateAgentPinnedFiles(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_pinned_files (
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      inside INTEGER NOT NULL,
      rank REAL NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, agent_id, path)
    );
  `)
}
