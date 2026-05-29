import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

export function migrateJobs(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      title TEXT NOT NULL,
      description TEXT,
      prompt TEXT NOT NULL,
      agent_id TEXT,
      mode_id TEXT,
      cinna_agent_id TEXT,
      cinna_priority TEXT,
      color_preset TEXT,
      icon_name TEXT,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_mcp_providers (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      mcp_provider_id TEXT NOT NULL REFERENCES mcp_providers(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, mcp_provider_id)
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      local_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      cinna_task_id TEXT,
      cinna_short_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
  `)

  // Track which chat (if any) was spawned by a Job run — lets the streaming
  // completion code flip the matching job_runs row without renderer cooperation.
  if (!hasColumn(sqlite, 'chats', 'originating_job_run_id')) {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN originating_job_run_id TEXT`)
  }

  // Hide job-spawned chats from the main chat list until the user explicitly
  // promotes them via "Move to Chats". Defaults to 0 so legacy chats stay
  // visible.
  if (!hasColumn(sqlite, 'chats', 'hidden_from_list')) {
    sqlite.exec(`ALTER TABLE chats ADD COLUMN hidden_from_list INTEGER NOT NULL DEFAULT 0`)
  }

  // Folders: user-defined groupings for sidebar jobs.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS job_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_folders_user_id ON job_folders(user_id);
  `)

  // folder_id / position on jobs — folder_id is nullable (root), position is
  // a per-group sort key managed by the reorder service.
  if (!hasColumn(sqlite, 'jobs', 'folder_id')) {
    sqlite.exec(`ALTER TABLE jobs ADD COLUMN folder_id TEXT`)
  }
  if (!hasColumn(sqlite, 'jobs', 'position')) {
    sqlite.exec(`ALTER TABLE jobs ADD COLUMN position INTEGER NOT NULL DEFAULT 0`)
  }

  // Multi-agent jobs: a job can attach several agents (orchestration model)
  // rather than the single `jobs.agent_id`. Create the join table and migrate
  // any existing single-agent jobs into it. The `agent_id` column is left in
  // place (dormant) — the repo reads `job_agents` exclusively after this.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS job_agents (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, agent_id)
    );
  `)
  // One-time backfill: copy each job's legacy single agent into job_agents,
  // then null the legacy column so the backfill can't re-run. Without the
  // UPDATE this would re-insert the old agent on every boot, resurrecting an
  // agent the user removed via the multi-agent UI (which only writes
  // job_agents). The `IN (SELECT id FROM agents)` guard skips dangling refs so
  // the FK insert can't throw (foreign_keys is ON); nulling a skipped dangling
  // ref is harmless since the agent doesn't exist.
  sqlite.exec(`
    INSERT OR IGNORE INTO job_agents (job_id, agent_id)
    SELECT id, agent_id FROM jobs
    WHERE agent_id IS NOT NULL
      AND agent_id IN (SELECT id FROM agents);
    UPDATE jobs SET agent_id = NULL WHERE agent_id IS NOT NULL;
  `)
}
