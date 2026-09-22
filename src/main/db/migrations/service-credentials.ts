import type Database from 'better-sqlite3'
export function migrateServiceCredentials(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS service_credentials (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, origin TEXT NOT NULL,
    cloud_id TEXT, server_origin TEXT, metadata TEXT NOT NULL,
    payload_enc BLOB, payload_fetched_at INTEGER, expires_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(user_id, server_origin, cloud_id)
  ); CREATE INDEX IF NOT EXISTS service_credentials_user ON service_credentials(user_id);`)
}
