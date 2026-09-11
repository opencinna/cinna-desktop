import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

/**
 * `tasks` — the unit of work that outlives a chat view — and
 * `task_input_requests`, the persistent twin of the in-memory pending-request
 * registry.
 *
 * Phase 5 of the agent runtime plan. Until now a job run *was* the record of
 * work, in two shapes that each produced their own row: a `local` run pointing
 * at a chat, and a `cinna_task` run pointing at a remote task. Nothing could
 * outlive its chat, change hands, or be answered with the chat closed.
 *
 * ## Why these columns and not others
 *
 * The vocabulary is cinna-core's (`src/shared/taskStatus.ts` explains why), so
 * `status`, `priority`, `goal` (its `original_message`) and `description` (its
 * `current_description`) line up field-for-field with a system that already has
 * a server and a web UI.
 *
 * `origin` and `executor` are two columns on purpose. `origin` is provenance
 * and never changes; `executor` is who is running it *now*, and flipping it is
 * how work changes hands in either direction. Collapsing them into one column
 * is what made `job.type` a permanent branch.
 *
 * The `remote_*` block is a binding to whatever system a `RemoteTaskAdapter`
 * speaks to — `remote_state` is opaque JSON that nothing outside
 * `src/main/tasks/adapters/` may read. There is deliberately no `cinna_task_id`
 * here: the next integration should add a file, not a column.
 *
 * ## No FK on the job columns
 *
 * `job_id` / `job_run_id` are provenance, and jobs can be deleted. A FK would
 * either cascade a task away with the job that started it — losing the record
 * of work that actually happened — or block the delete. They are also carried
 * across app-sync, where jobs sync and job *runs* do not, so a replica holds a
 * `job_run_id` that has no row on that device by design.
 *
 * ## `task_input_requests` does not sync
 *
 * A `reply`-mode ask is an address on *this* machine that dies with the driver
 * process holding it. A row for it on another device would be a lie: the button
 * would be there and nothing could answer. The remote half of the inbox needs
 * no row at all — it is `status = 'blocked'` on a task with `executor =
 * 'remote'`, which does sync, plus a live fetch when the row is opened.
 */
export function migrateTasks(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      priority TEXT NOT NULL DEFAULT 'normal',
      router TEXT NOT NULL DEFAULT 'direct',

      origin TEXT NOT NULL DEFAULT 'local',
      executor TEXT NOT NULL DEFAULT 'desktop',
      executor_device TEXT,

      chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      assignee_agent_id TEXT,
      assignee_name TEXT,
      assignee_kind TEXT NOT NULL DEFAULT 'model',
      assignee_ref TEXT,
      parent_task_id TEXT,
      job_id TEXT,
      job_run_id TEXT,

      remote_adapter TEXT,
      remote_id TEXT,
      remote_key TEXT,
      remote_url TEXT,
      remote_state TEXT,
      remote_synced_at INTEGER,
      remote_dirty TEXT,

      handoff_note TEXT,
      artifacts TEXT,
      budget TEXT,
      error_message TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      deleted_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_remote ON tasks(remote_adapter, remote_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

    CREATE TABLE IF NOT EXISTS task_handoffs (
      task_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT,
      receipt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_handoffs_user_chat ON task_handoffs(user_id, chat_id);

    CREATE TABLE IF NOT EXISTS task_input_requests (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      request TEXT NOT NULL,
      resume TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_task_input_requests_open
      ON task_input_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_input_requests_task
      ON task_input_requests(task_id);
  `)

  // Legacy request rows remain unowned; new events carry exact root/invocation
  // identity so a late or parallel turn cannot settle a sibling's request.
  for (const column of ['root_run_id', 'invocation_id']) {
    if (!hasColumn(sqlite, 'task_input_requests', column)) {
      sqlite.exec(`ALTER TABLE task_input_requests ADD COLUMN ${column} TEXT`)
    }
  }
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_task_input_requests_run
    ON task_input_requests(chat_id, root_run_id, invocation_id, status)`)

  // Which task a job run produced. Nullable for every run that predates this
  // migration: those rows are history, and inventing a task for each of them
  // would put tasks in the user's list for work that finished months ago with
  // no chat, no status trail and no way to act on them. New runs get one from
  // `jobService.execute`.
  //
  // `job_runs.cinna_task_id` / `cinna_short_code` are deliberately left alone.
  // They are mirrors of the task's `remote_id` / `remote_key` for one phase, so
  // a downgrade to the previous build still finds the remote task; phase 7
  // drops them.
  if (hasTable(sqlite, 'job_runs') && !hasColumn(sqlite, 'job_runs', 'task_id')) {
    sqlite.exec(`ALTER TABLE job_runs ADD COLUMN task_id TEXT`)
  }
}
