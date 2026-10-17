import type Database from 'better-sqlite3'

/**
 * `artifact_support`: the last *supported* answer to "can this profile
 * publish artifacts?", per (profile, server) — the instance name and limits
 * core gave. A relaunch starts from it, so Publish… is offered at once and
 * revalidated in the background; a definite "no artifacts" from core deletes
 * the row. Link origins are not kept: they are derived live.
 *
 * Creation only, no DML. After `users` (referenced).
 */
export function migrateArtifactSupport(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS artifact_support (
      profile_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_url TEXT NOT NULL,
      instance_name TEXT,
      max_revision_bytes INTEGER NOT NULL,
      max_revision_files INTEGER NOT NULL,
      max_file_bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile_user_id, server_url)
    );
  `)
}
