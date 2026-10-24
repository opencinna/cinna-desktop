import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * `mcp_providers.managed_by` — who owns a provider the user did not set up
 * by hand: `plugin:<entry_uuid>` for an MCP server a pinned marketplace
 * plugin brings (nullable text). A managed provider is created, attached,
 * re-pointed and removed with its plugin pin, and only its env values and
 * credentials are the user's to edit. Idempotent column add; no DML.
 */
export function migrateMcpManagedBy(sqlite: Database.Database): void {
  if (!hasColumn(sqlite, 'mcp_providers', 'managed_by')) {
    sqlite.exec('ALTER TABLE mcp_providers ADD COLUMN managed_by TEXT')
  }
}
