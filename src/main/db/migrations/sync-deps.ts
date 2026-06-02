import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * Portable Dependency Sync schema (plan: data-sync-portable-deps §6). Idempotent
 * column adds, slotted into `runMigrations()` after the jobs/agents/mcp tables
 * exist.
 *
 *   jobs.sync_deps             — JSON dependency manifest ({modeName, deps[]}),
 *                                the synced truth for a job's dependencies.
 *   mcp_providers.created_by_sync — provenance for providers auto-created from a
 *                                synced descriptor (disabled "finish setup" shell).
 *   agents.created_by_sync     — same provenance flag for auto-created local agents.
 */
export function runSyncDepsMigrations(sqlite: Database.Database): void {
  if (!hasColumn(sqlite, 'jobs', 'sync_deps')) {
    sqlite.exec('ALTER TABLE jobs ADD COLUMN sync_deps TEXT')
  }
  if (!hasColumn(sqlite, 'mcp_providers', 'created_by_sync')) {
    sqlite.exec('ALTER TABLE mcp_providers ADD COLUMN created_by_sync INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(sqlite, 'agents', 'created_by_sync')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN created_by_sync INTEGER NOT NULL DEFAULT 0')
  }
}
