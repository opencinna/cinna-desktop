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

  if (!hasColumn(sqlite, 'tasks', 'script')) sqlite.exec('ALTER TABLE tasks ADD COLUMN script TEXT')
  // User-defined fields (`TaskDto.customFields`), JSON; null for every task
  // that has none, which is every task written before this column.
  if (!hasColumn(sqlite, 'tasks', 'custom_fields')) sqlite.exec('ALTER TABLE tasks ADD COLUMN custom_fields TEXT')
  // Folder tasks (`.cinna/tasks/*.md`): the folder's own status word, the
  // device-local flag that keeps a path-bound task out of device sync, the
  // digest of content Cinna wrote, and the file as last read. All four are
  // null/false for every task written before them.
  if (!hasColumn(sqlite, 'tasks', 'status_label')) sqlite.exec('ALTER TABLE tasks ADD COLUMN status_label TEXT')
  if (!hasColumn(sqlite, 'tasks', 'device_local')) {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN device_local INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(sqlite, 'tasks', 'trusted_digest')) sqlite.exec('ALTER TABLE tasks ADD COLUMN trusted_digest TEXT')
  if (!hasColumn(sqlite, 'tasks', 'local_file')) sqlite.exec('ALTER TABLE tasks ADD COLUMN local_file TEXT')
  // Agent task tools (`tasks_create`): which agent created the task, from which
  // chat, and how deep in a chain of tool-created work it sits. All three are
  // device-local provenance — an agent id and a chat id mean nothing on another
  // device — so none of them travels in device sync. Null / 0 for every task a
  // person, a job or a pull created.
  if (!hasColumn(sqlite, 'tasks', 'created_by_agent_id')) sqlite.exec('ALTER TABLE tasks ADD COLUMN created_by_agent_id TEXT')
  if (!hasColumn(sqlite, 'tasks', 'created_by_chat_id')) sqlite.exec('ALTER TABLE tasks ADD COLUMN created_by_chat_id TEXT')
  if (!hasColumn(sqlite, 'tasks', 'chain_depth')) {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0')
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tasks_created_by_chat ON tasks(user_id, created_by_chat_id)')

  // Comments on a task (`tasks_comment`), written by an agent or — later — by a
  // person. Device-local, like the task rows a folder keeps: nothing sends them
  // to another device. `remote_status` is the best-effort copy to a bound
  // service's comment stream (`pending`, `sent`, `failed`) or the folder file's
  // log section; null when the task had nowhere to copy it.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    author_agent_id TEXT,
    body TEXT NOT NULL,
    remote_status TEXT,
    created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(user_id, task_id, created_at);`)

  // The task dispatcher (phase 4 of unified tasks). `dispatch_note` says why
  // the dispatcher left a task blocked; `agent_task_dispatch` is each folder
  // agent's run mode and pause, per profile (no row = manual), and
  // `agent_task_dispatch_runs` its runs in flight;
  // `task_dispatch_gates` is the Inbox approval asked before running content
  // that came from outside Cinna, one per task and digest. All device-local:
  // none is a synced collection, and the note is not in the task sync payload.
  if (!hasColumn(sqlite, 'tasks', 'dispatch_note')) sqlite.exec('ALTER TABLE tasks ADD COLUMN dispatch_note TEXT')
  // The agent whose queue still owns a dispatched task across an ask (and a restart).
  if (!hasColumn(sqlite, 'tasks', 'dispatch_agent_id')) sqlite.exec('ALTER TABLE tasks ADD COLUMN dispatch_agent_id TEXT')
  // The user started the task's current run: its turns may raise a desktop
  // notification. Device-local and never synced; an existing row reads false.
  if (!hasColumn(sqlite, 'tasks', 'started_by_user')) {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN started_by_user INTEGER NOT NULL DEFAULT 0')
  }
  // The bound conversation took the task on itself (`category: active`, or an
  // attaching `tasks_report`): settled by reports only, never by a turn's end.
  // False on every existing row.
  if (!hasColumn(sqlite, 'tasks', 'session_owned')) {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN session_owned INTEGER NOT NULL DEFAULT 0')
  }
  // `inboxService.taskForChat` made the task to hold a chat's first ask: the
  // only kind that gives way to a task the conversation takes on itself.
  // Device-local, never synced; false on every existing row.
  if (!hasColumn(sqlite, 'tasks', 'ask_born')) {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN ask_born INTEGER NOT NULL DEFAULT 0')
  }
  // Ownership goes with the conversation: when a chat is hard-deleted, its
  // `ON DELETE SET NULL` clears the task's `chat_id`, and this clears
  // `session_owned` in the same statement — on every delete path (a trashed
  // chat purged, the trash emptied, a job run's chat removed) — so a later
  // run in a fresh chat does not inherit report-only settlement. Leaves
  // `updated_at` alone, as `taskRepo.setSessionOwned` does.
  sqlite.exec(`CREATE TRIGGER IF NOT EXISTS tasks_session_owned_follows_chat
    AFTER UPDATE OF chat_id ON tasks
    WHEN NEW.chat_id IS NULL AND NEW.session_owned = 1
    BEGIN UPDATE tasks SET session_owned = 0 WHERE id = NEW.id; END`)
  // A folder binding stored before the dispatcher has no `trustedDigest`, and
  // its task row took what Cinna wrote as trusted. Nobody approved that
  // content, so it is untrusted until the user approves it once in the Inbox
  // (the adapter no longer falls back to `writtenDigest`). Idempotent: a
  // binding that records trust (even a null one) is left alone, and an
  // untrusted row stays untrusted.
  sqlite.exec(`UPDATE tasks SET trusted_digest = NULL
    WHERE remote_adapter = 'folder' AND trusted_digest IS NOT NULL
      AND (remote_state IS NULL OR json_valid(remote_state) = 0 OR json_type(remote_state, '$.trustedDigest') IS NULL)`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS agent_task_dispatch (
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'manual',
    max_runs INTEGER,
    paused_reason TEXT,
    paused_task_id TEXT,
    paused_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS agent_task_dispatch_runs (
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    chat_id TEXT,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, agent_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS task_dispatch_gates (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    title TEXT NOT NULL,
    file_path TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_dispatch_gates_digest ON task_dispatch_gates(user_id, task_id, digest);
  CREATE INDEX IF NOT EXISTS idx_task_dispatch_gates_open ON task_dispatch_gates(user_id, status);`)
  // `up_to` (several dispatched runs per agent): its N, and the runs in flight
  // moved from one pair of columns to a table of their own, so every run Cinna
  // quits under is found at boot. An install from before keeps its legacy
  // `active_*` columns; a run still recorded there is copied over once, and a
  // row left manual and unpaused by that is deleted (no row means manual).
  if (!hasColumn(sqlite, 'agent_task_dispatch', 'max_runs')) sqlite.exec('ALTER TABLE agent_task_dispatch ADD COLUMN max_runs INTEGER')
  if (hasColumn(sqlite, 'agent_task_dispatch', 'active_task_id')) {
    sqlite.transaction(() => sqlite.exec(`INSERT OR IGNORE INTO agent_task_dispatch_runs (user_id, agent_id, task_id, chat_id, started_at)
      SELECT user_id, agent_id, active_task_id, active_chat_id, updated_at FROM agent_task_dispatch WHERE active_task_id IS NOT NULL;
    UPDATE agent_task_dispatch SET active_task_id = NULL, active_chat_id = NULL WHERE active_task_id IS NOT NULL OR active_chat_id IS NOT NULL;
    DELETE FROM agent_task_dispatch WHERE mode = 'manual' AND paused_reason IS NULL;`))()
  }

  // Legacy request rows remain unowned; new events carry exact root/invocation
  // identity so a late or parallel turn cannot settle a sibling's request.
  for (const column of ['root_run_id', 'invocation_id']) {
    if (!hasColumn(sqlite, 'task_input_requests', column)) {
      sqlite.exec(`ALTER TABLE task_input_requests ADD COLUMN ${column} TEXT`)
    }
  }
  if (!hasColumn(sqlite, 'task_input_requests', 'delivery_owner')) {
    sqlite.exec("ALTER TABLE task_input_requests ADD COLUMN delivery_owner TEXT NOT NULL DEFAULT 'driver'")
  }
  const agentColumn = (sqlite.prepare('PRAGMA table_info(task_input_requests)').all() as { name: string; notnull: number }[])
    .find((column) => column.name === 'agent_id')
  if (agentColumn?.notnull) {
    // SQLite cannot relax NOT NULL in place. Keep all addresses, ownership,
    // answers and timestamps while allowing a genuine coordinator (no agent).
    sqlite.transaction(() => sqlite.exec(`CREATE TABLE task_input_requests_next (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL, agent_id TEXT, root_run_id TEXT, invocation_id TEXT,
      delivery_owner TEXT NOT NULL DEFAULT 'driver', request TEXT NOT NULL, resume TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', resolution TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
    );
    INSERT INTO task_input_requests_next
      (id, task_id, chat_id, agent_id, root_run_id, invocation_id, delivery_owner, request, resume, status, resolution, created_at, resolved_at)
      SELECT id, task_id, chat_id, agent_id, root_run_id, invocation_id, delivery_owner, request, resume, status, resolution, created_at, resolved_at
      FROM task_input_requests;
    DROP TABLE task_input_requests;
    ALTER TABLE task_input_requests_next RENAME TO task_input_requests;
    CREATE INDEX idx_task_input_requests_open ON task_input_requests(status, created_at);
    CREATE INDEX idx_task_input_requests_task ON task_input_requests(task_id);`))()
  }
  // An Inbox answer the task dispatcher sends when the agent has room in its queue
  // (a dispatch-owned task's `next_message` ask). After the rebuild above,
  // which would drop them. Null on every row before them.
  for (const column of ['queued_answer', 'queued_at', 'queued_error']) {
    if (!hasColumn(sqlite, 'task_input_requests', column)) {
      sqlite.exec(`ALTER TABLE task_input_requests ADD COLUMN ${column} ${column === 'queued_at' ? 'INTEGER' : 'TEXT'}`)
    }
  }
  sqlite.exec(`CREATE TABLE IF NOT EXISTS task_script_runtimes (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, checkpoint TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_task_script_runtimes_user ON task_script_runtimes(user_id);`)
  sqlite.exec(`CREATE TABLE IF NOT EXISTS task_runtimes (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, checkpoint TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_task_runtimes_user ON task_runtimes(user_id);`)
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
