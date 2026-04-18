import type Database from 'better-sqlite3'

export function migrateAgents(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      protocol TEXT NOT NULL,
      card_url TEXT,
      endpoint_url TEXT,
      protocol_interface_url TEXT,
      protocol_interface_version TEXT,
      access_token_enc BLOB,
      card_data TEXT,
      skills TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `)

  // Add columns for existing tables
  const cols = sqlite
    .prepare("PRAGMA table_info('agents')")
    .all() as Array<{ name: string }>
  const colNames = new Set(cols.map((c) => c.name))

  if (!colNames.has('protocol_interface_url')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN protocol_interface_url TEXT')
  }
  if (!colNames.has('protocol_interface_version')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN protocol_interface_version TEXT')
  }
  if (!colNames.has('source')) {
    sqlite.exec("ALTER TABLE agents ADD COLUMN source TEXT NOT NULL DEFAULT 'local'")
  }
  if (!colNames.has('remote_target_type')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN remote_target_type TEXT')
  }
  if (!colNames.has('remote_target_id')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN remote_target_id TEXT')
  }
  if (!colNames.has('remote_metadata')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN remote_metadata TEXT')
  }
}
