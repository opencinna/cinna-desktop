import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * `handovers` — the desktop's whole view of a `.cinna/handovers/<id>/` folder.
 *
 * Cinna reads that tree and writes nothing into it (`drafts/file_handovers`
 * §3.2), so every desktop-side fact about a handover — which task it became,
 * whether it ran, what the gate said, what the report claimed — lives here.
 *
 * Three column decisions are load-bearing:
 *
 * * **`agent_id` has no foreign key.** A bare agent's row id is derived from
 *   its path (`externalFolderAgentId`), and removing a folder from the agents
 *   list drops the `agents` row; putting it back re-creates the same id. A
 *   cascade would delete the history of work done in that folder because the
 *   user tidied a list, and a restrained FK would refuse the re-adoption.
 * * **`task_id` is `ON DELETE SET NULL`, not `CASCADE`.** A deleted task must
 *   not make the brief look new again — `UNIQUE(agent_id, handover_id)` is what
 *   stops a rescan creating a second task, and it can only do that if the row
 *   survives. A row with a null task and a non-terminal state reads as
 *   `skipped`.
 * * **`UNIQUE(agent_id, handover_id)`** is the dedupe. The handover id is the
 *   requester's, unique per folder only, so the pair is the identity and the
 *   database is what enforces "one brief, one task, forever" — not a read the
 *   next scan could race.
 *
 * Digests are sha256 of the file bytes, computed in main. They are the only
 * reason a rescan of an unchanged folder writes nothing at all.
 *
 * Two phase-4 columns:
 *
 * * **`revisions_delivered` is a JSON array of file names**, not a second
 *   table. A revision has no state of its own — it was sent on the handover's
 *   chat or it was not — so a row per revision would be a row per boolean, and
 *   every read of it happens together with the row it belongs to. The file name
 *   rather than the ordinal, because the file name is what the next scan has in
 *   its hand.
 * * **`brief_missing_at`** is when the brief stopped being on disk, and it is
 *   a column rather than a state because a withdrawn handover keeps every other
 *   fact it had: the task page still names the work and the requester, and only
 *   the row that points at `.cinna/handovers/<id>` has to stop claiming that
 *   directory is there (`ux_rules.md` §9). Cleared when a brief with that id is
 *   read again.
 * * **`summary`** is the last thing the executor said, so a group packet can be
 *   built from the rows alone. The report itself is the task's handoff note;
 *   this is the one line a fan-in list shows per member, and reading five
 *   tasks to build one sentence each would be the alternative.
 * * **`brief_stat` / `report_stat`** are `mtimeNs:size` of the two files as the
 *   last scan found them. The digests say whether the *content* moved; these
 *   say whether it is worth opening the file to find out, once a minute, for
 *   every handover of every project.
 */

/**
 * Every column that may be missing from a `handovers` table created by an
 * earlier development build, with the type the ALTER needs.
 *
 * The table is unreleased, so no shipped profile needs any of this — but this
 * feature grew a column at a time across several development builds, and
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there.
 * A machine that ran any intermediate build would be short every column added
 * after it, for ever, and every read of a row would throw. The list is the
 * nullable and defaulted part of the `CREATE TABLE` above: `brief_digest` and
 * the four identity columns are in every shape the table has ever had, and
 * `NOT NULL` without a default cannot be added by ALTER anyway.
 */
const ADDED_COLUMNS: readonly (readonly [string, string])[] = [
  ['origin_agent_id', 'TEXT'],
  ['origin_chat_id', 'TEXT'],
  ['origin_task_id', 'TEXT'],
  ['depth', 'INTEGER NOT NULL DEFAULT 1'],
  ['group_id', 'TEXT'],
  ['execution', "TEXT NOT NULL DEFAULT 'ask'"],
  ['refusal_reason', 'TEXT'],
  ['warning', 'TEXT'],
  ['brief_stat', 'TEXT'],
  ['report_digest', 'TEXT'],
  ['report_stat', 'TEXT'],
  ['report_status', 'TEXT'],
  ['summary', 'TEXT'],
  ['revisions_delivered', 'TEXT'],
  ['gate_request_id', 'TEXT'],
  ['gate_chat_id', 'TEXT'],
  ['run_id', 'TEXT'],
  ['woke_at', 'INTEGER'],
  ['wake_run_id', 'TEXT'],
  ['brief_missing_at', 'INTEGER'],
  ['last_scanned_at', 'INTEGER']
]
export function migrateHandovers(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS handovers (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    handover_id TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    origin_agent_id TEXT,
    origin_chat_id TEXT,
    origin_task_id TEXT,
    depth INTEGER NOT NULL DEFAULT 1,
    group_id TEXT,
    execution TEXT NOT NULL DEFAULT 'ask',
    state TEXT NOT NULL DEFAULT 'seen',
    refusal_reason TEXT,
    warning TEXT,
    brief_digest TEXT NOT NULL,
    brief_stat TEXT,
    report_digest TEXT,
    report_stat TEXT,
    report_status TEXT,
    summary TEXT,
    revisions_delivered TEXT,
    gate_request_id TEXT,
    gate_chat_id TEXT,
    run_id TEXT,
    woke_at INTEGER,
    wake_run_id TEXT,
    brief_missing_at INTEGER,
    last_scanned_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(agent_id, handover_id)
  );`)

  for (const [name, type] of ADDED_COLUMNS) {
    if (!hasColumn(sqlite, 'handovers', name)) {
      sqlite.exec(`ALTER TABLE handovers ADD COLUMN ${name} ${type}`)
    }
  }

  // **After** the columns, not with the table. `idx_handovers_group` is over
  // `origin_chat_id` and `group_id`, and an index over a column the table does
  // not have yet is an error that would abort the whole migration pass on
  // exactly the old databases the ALTERs above exist for.
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_handovers_user ON handovers(user_id, state);
  CREATE INDEX IF NOT EXISTS idx_handovers_task ON handovers(task_id);
  CREATE INDEX IF NOT EXISTS idx_handovers_agent ON handovers(agent_id);
  CREATE INDEX IF NOT EXISTS idx_handovers_group ON handovers(user_id, origin_chat_id, group_id);`)
}
