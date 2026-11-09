import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * Dashboards (D1): per-profile grids of tiles, and the last result per tile.
 *
 * - `dashboards` — one row per dashboard, per profile.
 * - `dashboard_tiles` — the user's placement of a component: the agent by its
 *   manifest id (so a moved or renamed folder keeps its tiles), the component
 *   by its folder name, a title override, size, position, params and a
 *   refresh override. Goes with its dashboard. `skill` (D2) names the skill
 *   that ships the component (`<skill>/dashboards/<name>/`), null for the
 *   agent's own; added by an idempotent column add, so a D1 row reads null.
 * - `dashboard_tile_results` — the last good result per (tile, params hash)
 *   and the last error beside it. A failure never clears `result_json`. At
 *   most three param sets per tile are kept (`dashboardRepo.saveResult`).
 *
 * Creation and idempotent column adds (D2 `skill`, D6 cloud columns), no DML.
 * After `users` (referenced).
 */
export function migrateDashboards(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      profile_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboards_profile ON dashboards(profile_user_id, sort_order);
    CREATE TABLE IF NOT EXISTS dashboard_tiles (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      agent_manifest_id TEXT NOT NULL,
      component TEXT NOT NULL,
      title TEXT,
      size TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      params_json TEXT NOT NULL DEFAULT '{}',
      refresh_override_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_tiles_dashboard ON dashboard_tiles(dashboard_id, position);
    CREATE INDEX IF NOT EXISTS idx_dashboard_tiles_agent ON dashboard_tiles(agent_manifest_id);
    CREATE TABLE IF NOT EXISTS dashboard_tile_results (
      tile_id TEXT NOT NULL REFERENCES dashboard_tiles(id) ON DELETE CASCADE,
      params_hash TEXT NOT NULL,
      result_json TEXT,
      fetched_at INTEGER,
      error TEXT,
      duration_ms INTEGER,
      too_large INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tile_id, params_hash)
    );
  `)
  if (!hasColumn(sqlite, 'dashboard_tiles', 'skill')) {
    sqlite.exec('ALTER TABLE dashboard_tiles ADD COLUMN skill TEXT')
  }
  // D6 cloud tiles. A dashboard with cloud tiles is backed by one core
  // dashboard (`core_dashboard_id`), made on `core_server` (the profile's
  // server URL then). A cloud tile row has `source = 'remote'`, the core
  // agent in `remote_agent_id`, its block in `core_block_id`, and `''` in
  // `agent_manifest_id` (kept NOT NULL: no table rebuild). Its result is one
  // mirror row in `dashboard_tile_results` under params hash `cloud`.
  if (!hasColumn(sqlite, 'dashboards', 'core_dashboard_id')) {
    sqlite.exec('ALTER TABLE dashboards ADD COLUMN core_dashboard_id TEXT')
  }
  if (!hasColumn(sqlite, 'dashboards', 'core_server')) {
    sqlite.exec('ALTER TABLE dashboards ADD COLUMN core_server TEXT')
  }
  if (!hasColumn(sqlite, 'dashboard_tiles', 'source')) {
    sqlite.exec("ALTER TABLE dashboard_tiles ADD COLUMN source TEXT NOT NULL DEFAULT 'local'")
  }
  if (!hasColumn(sqlite, 'dashboard_tiles', 'remote_agent_id')) {
    sqlite.exec('ALTER TABLE dashboard_tiles ADD COLUMN remote_agent_id TEXT')
  }
  if (!hasColumn(sqlite, 'dashboard_tiles', 'core_block_id')) {
    sqlite.exec('ALTER TABLE dashboard_tiles ADD COLUMN core_block_id TEXT')
  }
  // The component as core last described it (`CoreComponent` JSON), so a
  // cloud tile draws its view offline and after a restart.
  if (!hasColumn(sqlite, 'dashboard_tiles', 'cloud_component_json')) {
    sqlite.exec('ALTER TABLE dashboard_tiles ADD COLUMN cloud_component_json TEXT')
  }
  // The user's own cells (`size = 'custom'`) and changes to the component's suggested questions.
  for (const [column, type] of [['custom_cols', 'INTEGER'], ['custom_rows', 'INTEGER'], ['prompt_override_json', 'TEXT']]) {
    if (!hasColumn(sqlite, 'dashboard_tiles', column)) sqlite.exec(`ALTER TABLE dashboard_tiles ADD COLUMN ${column} ${type}`)
  }
  // The Interface switches of Edit tile: an existing tile keeps its border and title.
  for (const column of ['show_border', 'show_title']) {
    if (!hasColumn(sqlite, 'dashboard_tiles', column)) sqlite.exec(`ALTER TABLE dashboard_tiles ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 1`)
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_dashboard_tiles_remote_agent ON dashboard_tiles(remote_agent_id)')
}
