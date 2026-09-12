import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

export function migrateMcp(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcp_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport_type TEXT NOT NULL,
      command TEXT,
      args TEXT,
      url TEXT,
      env TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `)

  if (!hasColumn(sqlite, 'mcp_providers', 'auth_tokens_enc')) {
    sqlite.exec(`ALTER TABLE mcp_providers ADD COLUMN auth_tokens_enc BLOB`)
    sqlite.exec(`ALTER TABLE mcp_providers ADD COLUMN client_info TEXT`)
  }

  if (!hasColumn(sqlite, 'mcp_providers', 'auth_type')) {
    sqlite.exec(`ALTER TABLE mcp_providers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'oauth'`)
    sqlite.exec(`ALTER TABLE mcp_providers ADD COLUMN bearer_token_enc BLOB`)
  }
  if (!hasColumn(sqlite, 'mcp_providers', 'oauth_discovery_state')) {
    sqlite.exec(`ALTER TABLE mcp_providers ADD COLUMN oauth_discovery_state TEXT`)
  }
  if (!hasColumn(sqlite, 'mcp_providers', 'config_revision')) {
    sqlite.exec(`ALTER TABLE mcp_providers ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0`)
  }
}
