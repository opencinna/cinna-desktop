import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { adaptDatabase } from '../testSupport/nodeSqlite'
import { runAllMigrations } from './index'

/**
 * The fresh-install replay, as section 10 of the review command specifies it:
 * start from an empty database, run the whole chain in `runMigrations()` order,
 * and watch for the failure mode this project actually shipped once — DML whose
 * `ON DELETE CASCADE` chain compiles against a table a later migration creates,
 * which throws `no such table` even with zero rows.
 *
 * These run against `node:sqlite` rather than `better-sqlite3`, whose binding is
 * built for Electron; it is the same SQLite engine and the same statement
 * compiler, which is what the ordering trap is about. See `testSupport/nodeSqlite.ts`.
 */

function freshDatabase(): DatabaseSync {
  const raw = new DatabaseSync(':memory:')
  // Exactly what `initDatabase` does around the pass.
  raw.exec('PRAGMA foreign_keys = OFF')
  runAllMigrations(adaptDatabase(raw))
  raw.exec('PRAGMA foreign_keys = ON')
  return raw
}

function tableNames(raw: DatabaseSync): Set<string> {
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
    name: string
  }>
  return new Set(rows.map((r) => r.name))
}

function columnNames(raw: DatabaseSync, table: string): Set<string> {
  const rows = raw.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

describe('the migration chain on a fresh install', () => {
  it('replays from an empty database without throwing', () => {
    expect(() => freshDatabase()).not.toThrow()
  })

  it('creates agent_roots and the folder-agent columns', () => {
    const raw = freshDatabase()
    expect(tableNames(raw)).toContain('agent_roots')

    const rootCols = columnNames(raw, 'agent_roots')
    for (const col of ['id', 'user_id', 'path', 'label', 'is_default', 'created_at']) {
      expect(rootCols).toContain(col)
    }

    const agentCols = columnNames(raw, 'agents')
    expect(agentCols).toContain('local_path')
    expect(agentCols).toContain('local_root_id')
    // Added by the last migration in the chain, over a table created early.
    expect(agentCols).toContain('user_id')
    raw.close()
  })

  it('leaves referential integrity intact', () => {
    const raw = freshDatabase()
    const violations = raw.prepare('PRAGMA foreign_key_check').all()
    expect(violations).toEqual([])
    raw.close()
  })

  it('is a no-op the second time — and the third', () => {
    const raw = freshDatabase()
    const before = tableNames(raw)
    const sqlite = adaptDatabase(raw)
    expect(() => runAllMigrations(sqlite)).not.toThrow()
    expect(() => runAllMigrations(sqlite)).not.toThrow()
    expect(tableNames(raw)).toEqual(before)
    expect(columnNames(raw, 'agents')).toContain('local_path')
    raw.close()
  })

  it('re-runs cleanly over a database that already holds rows', () => {
    // The upgrade path: an existing install, not an empty file. A migration
    // that only works against zero rows fails here.
    const raw = freshDatabase()
    raw
      .prepare(
        `INSERT INTO agent_roots (id, user_id, path, label, is_default, created_at)
         VALUES ('r1', '__default__', '/tmp/workshop', 'Agents', 1, ?)`
      )
      .run(Date.now())
    raw
      .prepare(
        `INSERT INTO agents (id, user_id, name, protocol, enabled, source, local_path, local_root_id, created_at)
         VALUES ('folder:abc', '__default__', 'A', 'local-folder', 1, 'folder', '/tmp/workshop/Local/a', 'r1', ?)`
      )
      .run(Date.now())

    expect(() => runAllMigrations(adaptDatabase(raw))).not.toThrow()

    const rows = raw.prepare('SELECT id, local_root_id FROM agents').all()
    expect(rows).toEqual([{ id: 'folder:abc', local_root_id: 'r1' }])
    raw.close()
  })

  it('starts a fresh install with only the default user and no agent rows', () => {
    const raw = freshDatabase()
    const users = raw.prepare('SELECT id FROM users').all() as Array<{ id: string }>
    expect(users.map((u) => u.id)).toEqual(['__default__'])
    expect(raw.prepare('SELECT COUNT(*) AS c FROM agent_roots').get()).toEqual({ c: 0 })
    raw.close()
  })
})
