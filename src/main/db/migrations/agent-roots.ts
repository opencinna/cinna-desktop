import type Database from 'better-sqlite3'

/**
 * `agent_roots` — the workshop folders local (folder) agents are scanned from.
 *
 * One row per registered root: the agents home (`is_default = 1`, exactly one)
 * plus any extra folder the user adopted. `agents.local_root_id` points here,
 * but **without** a SQL foreign key on purpose:
 *
 * * A folder agent's row is a derived index (Invariant 1). Removing a root
 *   prunes its agents explicitly, in the same transaction, through
 *   `agentRepo.replaceFolderIndex` / `pruneFolderIndexForRoot` — a cascade
 *   would hide that, and would put a second FK edge on `agents`, which is the
 *   table the fresh-install FK-cascade crash was about
 *   (see `docs/core/boot_resilience/`).
 * * With no FK, the ordering of this migration relative to `migrateAgents` is
 *   a correctness question about *columns*, not about cascade compilation.
 *
 * Fresh-install safety: this migration only creates its own table and index,
 * both `IF NOT EXISTS`, and touches no other table. Running it twice is a
 * no-op. It carries `user_id` from the start, so `migrateUserIdColumns` has
 * nothing to backfill here.
 */
export function migrateAgentRoots(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_roots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      label TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_roots_user_id ON agent_roots(user_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_roots_user_path
      ON agent_roots(user_id, path);
  `)
}
