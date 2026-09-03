/**
 * **Test support only.** Nothing in `src/main` imports this at runtime.
 *
 * The app's SQLite handle is `better-sqlite3`, whose native binding is compiled
 * against Electron's ABI and refuses to load under plain Node (`ERR_DLOPEN_FAILED`).
 * That would leave the two things section 10 of the review command insists on —
 * replaying every migration against an empty database, and proving a second run
 * is a no-op — untestable, along with every repository transaction.
 *
 * Node 22 ships `node:sqlite`, the same engine behind a different API. This
 * module adapts it to the small surface the app actually uses, so tests drive
 * the *real* migration chain and the *real* Drizzle repositories rather than a
 * hand-written imitation of them.
 *
 * The adapter is deliberately narrow. Drizzle's `better-sqlite3` driver touches
 * exactly four things — `client.prepare`, `client.transaction`, `stmt.run` and
 * `stmt.raw().all()` — and the migrations touch `exec`, `prepare().all()` and
 * `prepare().get()`. Everything else is left unimplemented on purpose: a test
 * that reaches past this surface should fail loudly, not silently diverge from
 * what ships.
 */

import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../schema'
import { runAllMigrations } from '../migrations'

type Row = Record<string, unknown>
type Param = null | number | bigint | string | Uint8Array

function toParams(values: unknown[]): Param[] {
  return values.map((value) => {
    if (value === undefined || value === null) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return value.getTime()
    return value as Param
  })
}

/**
 * A statement shaped like `better-sqlite3`'s.
 *
 * `raw()` is the one piece `node:sqlite` has no equivalent for: Drizzle asks
 * for rows as positional arrays and maps them by the field order it compiled.
 * `node:sqlite` returns objects whose key order is the result's column order,
 * so `Object.values` reproduces exactly that array. This holds for the app's
 * queries, which select from a single table; a join that selected two columns
 * of the same name would collide, and there is none.
 */
function wrapStatement(stmt: ReturnType<DatabaseSync['prepare']>) {
  const api = {
    run: (...params: unknown[]) => {
      const result = stmt.run(...toParams(params))
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
    },
    get: (...params: unknown[]) => stmt.get(...toParams(params)) as Row | undefined,
    all: (...params: unknown[]) => stmt.all(...toParams(params)) as Row[],
    raw: () => ({
      all: (...params: unknown[]) =>
        (stmt.all(...toParams(params)) as Row[]).map((row) => Object.values(row)),
      get: (...params: unknown[]) => {
        const row = stmt.get(...toParams(params)) as Row | undefined
        return row === undefined ? undefined : Object.values(row)
      }
    })
  }
  return api
}

/** A `better-sqlite3`-shaped facade over a `node:sqlite` connection. */
export function adaptDatabase(raw: DatabaseSync): Database.Database {
  let depth = 0
  const client = {
    exec: (sql: string) => {
      raw.exec(sql)
      return client
    },
    prepare: (sql: string) => wrapStatement(raw.prepare(sql)),
    /**
     * `better-sqlite3.transaction(fn)` returns a callable that wraps `fn` in
     * BEGIN/COMMIT, with savepoints when nested, and carries `.deferred` /
     * `.immediate` / `.exclusive` variants — Drizzle calls one of those by name
     * rather than the function itself. All three map to the same wrapper here:
     * the locking mode is irrelevant to a single-connection in-memory database,
     * while the rollback-on-throw behaviour Drizzle relies on is not.
     */
    transaction: <T extends (...args: never[]) => unknown>(fn: T) => {
      const run = (...args: Parameters<T>): ReturnType<T> => {
        const nested = depth > 0
        const name = `sp_${depth}`
        raw.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN')
        depth++
        try {
          const result = fn(...args) as ReturnType<T>
          raw.exec(nested ? `RELEASE ${name}` : 'COMMIT')
          return result
        } catch (err) {
          raw.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK')
          throw err
        } finally {
          depth--
        }
      }
      return Object.assign(run, { deferred: run, immediate: run, exclusive: run })
    },
    pragma: (source: string) => {
      raw.exec(`PRAGMA ${source}`)
      return []
    },
    close: () => raw.close()
  }
  return client as unknown as Database.Database
}

export interface TestDatabase {
  raw: DatabaseSync
  sqlite: Database.Database
  db: BetterSQLite3Database<typeof schema>
  close(): void
}

/**
 * An in-memory database with the production migration chain applied, exactly as
 * `initDatabase` applies it: foreign keys off for the pass, on afterwards.
 */
export function createTestDatabase(): TestDatabase {
  const raw = new DatabaseSync(':memory:')
  const sqlite = adaptDatabase(raw)
  raw.exec('PRAGMA foreign_keys = OFF')
  runAllMigrations(sqlite)
  raw.exec('PRAGMA foreign_keys = ON')
  return {
    raw,
    sqlite,
    db: drizzle(sqlite, { schema }),
    close: () => raw.close()
  }
}
