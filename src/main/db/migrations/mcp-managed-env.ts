import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * Two nullable columns for a provider a marketplace plugin owns
 * (`managed_by`), both unused by any other provider:
 *
 * * `env_secret_enc` — the values the user gives for the plugin's `${VAR}`
 *   placeholders, as one encrypted JSON object (safeStorage, like
 *   `bearer_token_enc`). Read in main only, at launch; the renderer sees the
 *   names and whether each has a value.
 * * `managed_spec` — JSON: the cached plugin folder the row runs from, the
 *   names that are the user's to fill in, and an HTTP server's declared
 *   headers (placeholders unresolved).
 *
 * Idempotent column adds; no DML.
 */
export function migrateMcpManagedEnv(sqlite: Database.Database): void {
  if (!hasColumn(sqlite, 'mcp_providers', 'env_secret_enc')) {
    sqlite.exec('ALTER TABLE mcp_providers ADD COLUMN env_secret_enc BLOB')
  }
  if (!hasColumn(sqlite, 'mcp_providers', 'managed_spec')) {
    sqlite.exec('ALTER TABLE mcp_providers ADD COLUMN managed_spec TEXT')
  }
}
