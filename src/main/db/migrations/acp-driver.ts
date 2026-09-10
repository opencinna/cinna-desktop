import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

/**
 * `agents.driver` collapses `opencode` and `claude` into `acp`, and the engine
 * moves into `driver_config.launcher`.
 *
 * Phase 3 of the agent runtime plan. Both engines are now run by one driver
 * over the Agent Client Protocol, so which engine an agent uses stopped being
 * an identity and became a setting of the driver that runs it — the same
 * separation `source` and `driver` got in phase 2, one level further down.
 *
 * Runs after {@link migrateAgentDrivers}, whose backfill is what put those two
 * values in the column in the first place, and is `hasTable`/`hasColumn`-
 * guarded because it is DML on a table another migration creates.
 *
 * **Idempotent by its predicate.** The launcher is written only where the
 * column still names an engine, and a row already on `acp` is never rewritten —
 * so a second boot, or a downgrade-then-upgrade, cannot overwrite a launcher
 * the scanner has since corrected. The order inside is load-bearing: the config
 * is written *from* `driver` before `driver` is overwritten, and both statements
 * select on the same predicate, so an interrupted migration re-runs cleanly.
 *
 * `driver_config` is written with `json_object` rather than a string literal
 * because the column is read as JSON by Drizzle (`{ mode: 'json' }`), and a
 * hand-rolled `'{"launcher":"claude"}'` is one missed brace away from a row
 * whose config silently reads as null — which would put the agent on the
 * default engine until its next rescan.
 *
 * A row that somehow carries a `driver_config` already is left alone rather
 * than merged: nothing wrote one before this migration, so a value here is
 * either from a newer build or from a repair, and both know better than we do.
 */
export function migrateAcpDriver(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'agents')) return
  if (!hasColumn(sqlite, 'agents', 'driver')) return
  if (!hasColumn(sqlite, 'agents', 'driver_config')) return

  sqlite.exec(
    `UPDATE agents
        SET driver_config = json_object('launcher', driver)
      WHERE driver IN ('opencode', 'claude')
        AND (driver_config IS NULL OR trim(driver_config) = '')`
  )
  sqlite.exec("UPDATE agents SET driver = 'acp' WHERE driver IN ('opencode', 'claude')")
}
