import type Database from 'better-sqlite3'

export function migrateLocalSchedules(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS local_schedule_bindings (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    manifest_id TEXT NOT NULL,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    revision TEXT NOT NULL,
    job_id TEXT NOT NULL,
    job_fingerprint TEXT NOT NULL,
    job_ids TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    watermark INTEGER NOT NULL,
    UNIQUE(user_id, manifest_id, name)
  );
  CREATE TABLE IF NOT EXISTS local_schedule_occurrences (
    id TEXT PRIMARY KEY NOT NULL,
    binding_id TEXT NOT NULL REFERENCES local_schedule_bindings(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    civil_key TEXT NOT NULL,
    utc_minute INTEGER NOT NULL,
    definition TEXT NOT NULL,
    revision TEXT NOT NULL,
    status TEXT NOT NULL,
    task_id TEXT,
    run_id TEXT,
    chat_id TEXT,
    reason TEXT,
    UNIQUE(binding_id, civil_key)
  );
  CREATE INDEX IF NOT EXISTS idx_local_schedule_user ON local_schedule_bindings(user_id);
  CREATE INDEX IF NOT EXISTS idx_local_schedule_occurrences_binding ON local_schedule_occurrences(binding_id, utc_minute);`)
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_local_schedule_occurrences_state ON local_schedule_occurrences(binding_id, status)')
}
