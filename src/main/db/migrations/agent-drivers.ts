import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

/**
 * `agents.driver` and `agents.driver_config` — which driver runs a row, and
 * that driver's own settings (JSON, opaque outside `src/main/agents/drivers/`).
 *
 * Phase 2 of the agent runtime plan. `source` keeps its meaning of ownership
 * and sync scope; `driver` is how the agent runs.
 *
 * Alters and updates `agents`, a table `migrateAgents` creates — so, by the
 * ordering rules in `docs/development/migrations/migrations_llm.md`, it runs
 * after every table-creation migration and is `hasTable`-guarded.
 *
 * **The backfill is idempotent by its predicate** (`driver IS NULL`): a row
 * that already names a driver is never rewritten, on this boot or any later
 * one. A hand-added or Cinna-synced row runs on A2A. A folder row starts on
 * the default engine; the scanner writes the engine its runtime names on its
 * next pass, and the folder drivers reconcile against the folder on every turn
 * until it has — so a Claude folder backfilled as `opencode` never runs on the
 * wrong engine.
 */
export function migrateAgentDrivers(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'agents')) return
  if (!hasColumn(sqlite, 'agents', 'driver')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN driver TEXT')
  }
  if (!hasColumn(sqlite, 'agents', 'driver_config')) {
    sqlite.exec('ALTER TABLE agents ADD COLUMN driver_config TEXT')
  }
  sqlite.exec(
    "UPDATE agents SET driver = 'a2a' WHERE driver IS NULL AND source IN ('local', 'remote')"
  )
  sqlite.exec("UPDATE agents SET driver = 'opencode' WHERE driver IS NULL AND source = 'folder'")
}
