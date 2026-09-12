import { encryptApiKey } from '../security/keystore'
import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { runAllMigrations } from './migrations'
import { chatModeRepo } from './chatModes'
import { taskInputRequestRepo } from './taskInputRequests'
import { createLogger } from '../logger/logger'

const logger = createLogger('db')

let db: BetterSQLite3Database<typeof schema>
let sqlite: Database.Database

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'cinna.db')
  sqlite = new Database(dbPath)

  sqlite.pragma('journal_mode = WAL')

  // Foreign-key enforcement is disabled WHILE migrations run, then re-enabled.
  // Rationale: SQLite resolves `ON DELETE CASCADE` chains at statement-prepare
  // time, so a CREATE/DML in an early migration that touches a table whose FK
  // points at a not-yet-created parent (e.g. `chat_on_demand_agents` →
  // `agents`) throws `no such table` on a fresh install — even with zero rows.
  // Turning FK off during migrations makes table-creation order irrelevant for
  // referential integrity; the post-migration re-enable restores enforcement
  // for the app's runtime. This is the standard SQLite schema-migration pattern.
  sqlite.pragma('foreign_keys = OFF')

  db = drizzle(sqlite, { schema })

  runMigrations()

  sqlite.pragma('foreign_keys = ON')

  runConsistencyChecks()
}

/**
 * Idempotent boot-time data healing. Migrations handle schema; this handles
 * orphaned references in JSON columns (which have no FK enforcement). Each
 * check runs inside `safeRun` so a buggy or data-tripped cleanup can never
 * block app startup — the worst case is the previous behavior (stale data
 * left in place).
 */
function runConsistencyChecks(): void {
  safeRun('encrypt-mcp-client-registrations', () => {
    const rows = sqlite.prepare('SELECT id, client_info FROM mcp_providers WHERE client_info IS NOT NULL').all() as { id: string; client_info: string }[]
    for (const row of rows) {
      const registration = JSON.parse(row.client_info)
      if (typeof registration.encrypted !== 'string') {
        sqlite.prepare('UPDATE mcp_providers SET client_info = ? WHERE id = ?').run(
          JSON.stringify({ encrypted: encryptApiKey(row.client_info).toString('base64') }), row.id)
      }
    }
  })
  safeRun('prune-dangling-mcp-ids', () => {
    const touched = chatModeRepo.pruneDanglingMcpProviderIds()
    if (touched > 0) {
      logger.info('boot-cleanup:pruned-dangling-mcp-ids-from-chat-modes', { touched })
    }
  })
  // An open ask is an address inside a driver process, and no driver process
  // survived the restart that got us here. Without this the inbox would offer
  // buttons whose only possible outcome is "no longer waiting for an answer".
  safeRun('expire-orphaned-input-requests', () => {
    const expired = taskInputRequestRepo.expireOpen()
    if (expired > 0) {
      logger.info('boot-cleanup:expired-orphaned-input-requests', { expired })
    }
  })
}

function safeRun(name: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    logger.error('boot-cleanup:failed', {
      check: name,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Run the migration chain against this connection. The chain itself lives in
 * `migrations/index.ts` so it can be replayed against an empty database by the
 * test suite — `better-sqlite3`'s binding is built for Electron and will not
 * load under plain Node.
 */
function runMigrations(): void {
  runAllMigrations(sqlite)
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return db
}

/** Raw better-sqlite3 handle, for repos that issue hand-written SQL (sync). */
export function getRawSqlite(): Database.Database {
  return sqlite
}
