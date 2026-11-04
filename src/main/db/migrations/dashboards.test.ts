import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { adaptDatabase } from '../testSupport/nodeSqlite'
import { migrateDashboards } from './dashboards'

const columns = (raw: DatabaseSync, table: string): string[] => (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)

describe('dashboards migration (D6 cloud columns)', () => {
  it('adds the cloud columns to a D5 database, keeps its rows as local tiles, and runs again without change', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('p1');")
    // A D5 shape: the tables without the D6 columns, one tile in them.
    raw.exec(`CREATE TABLE dashboards (id TEXT PRIMARY KEY, profile_user_id TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE dashboard_tiles (id TEXT PRIMARY KEY, dashboard_id TEXT NOT NULL, agent_manifest_id TEXT NOT NULL, component TEXT NOT NULL, title TEXT, size TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, params_json TEXT NOT NULL DEFAULT '{}', refresh_override_json TEXT, skill TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO dashboards VALUES ('d1', 'p1', 'Sales', 0, 1, 1);
      INSERT INTO dashboard_tiles (id, dashboard_id, agent_manifest_id, component, size, created_at, updated_at) VALUES ('t1', 'd1', 'm1', 'deals', 'm', 1, 1);`)
    migrateDashboards(adaptDatabase(raw))
    expect(columns(raw, 'dashboards')).toEqual(expect.arrayContaining(['core_dashboard_id', 'core_server']))
    expect(columns(raw, 'dashboard_tiles')).toEqual(expect.arrayContaining(['source', 'remote_agent_id', 'core_block_id', 'cloud_component_json']))
    expect(raw.prepare("SELECT source, remote_agent_id, core_block_id, cloud_component_json FROM dashboard_tiles WHERE id = 't1'").get()).toEqual({
      source: 'local', remote_agent_id: null, core_block_id: null, cloud_component_json: null
    })
    expect(raw.prepare("SELECT core_dashboard_id, core_server FROM dashboards WHERE id = 'd1'").get()).toEqual({ core_dashboard_id: null, core_server: null })
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_dashboard_tiles_remote_agent'").get()).toBeTruthy()
    migrateDashboards(adaptDatabase(raw))
    expect(columns(raw, 'dashboard_tiles').filter((name) => name === 'source')).toHaveLength(1)
    raw.close()
  })

  it('creates the tables with the cloud columns on a fresh database', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
    migrateDashboards(adaptDatabase(raw))
    expect(columns(raw, 'dashboard_tiles')).toEqual(expect.arrayContaining(['skill', 'source', 'remote_agent_id', 'core_block_id', 'cloud_component_json']))
    raw.close()
  })
})
