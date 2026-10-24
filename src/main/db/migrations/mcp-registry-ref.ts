import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * `mcp_providers.registry_ref` — the `{source, id}` of the addon directory
 * entry a local MCP provider was created from (a JSON text, nullable). The
 * addon directory shows such a provider once, as "On this computer", instead
 * of beside its directory entry. Idempotent column add; no DML.
 */
export function migrateMcpRegistryRef(sqlite: Database.Database): void {
  if (!hasColumn(sqlite, 'mcp_providers', 'registry_ref')) {
    sqlite.exec('ALTER TABLE mcp_providers ADD COLUMN registry_ref TEXT')
  }
}
