import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { migrateProviders } from './migrations/providers'
import { migrateMcp } from './migrations/mcp'
import { migrateChats } from './migrations/chats'
import { migrateMessages } from './migrations/messages'
import { migrateChatModes } from './migrations/chat-modes'
import { migrateAgents } from './migrations/agents'
import { migrateA2aSessions } from './migrations/a2a-sessions'
import { migrateAgentOverrides } from './migrations/agent-overrides'
import { migrateAccountConfig } from './migrations/account-config'
import { migrateUsers, migrateUserIdColumns } from './migrations/users'
import { migrateChatFiles } from './migrations/chat-files'
import { migrateJobs } from './migrations/jobs'
import { migrateNotes } from './migrations/notes'
import { migrateAppSettings } from './migrations/app-settings'
import { runSyncMigrations } from './migrations/sync'
import { runSyncDepsMigrations } from './migrations/sync-deps'
import { chatModeRepo } from './chatModes'
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
  safeRun('prune-dangling-mcp-ids', () => {
    const touched = chatModeRepo.pruneDanglingMcpProviderIds()
    if (touched > 0) {
      logger.info('boot-cleanup:pruned-dangling-mcp-ids-from-chat-modes', { touched })
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

function runMigrations(): void {
  // Users table first (referenced by all data tables)
  migrateUsers(sqlite)
  // Order matters: providers, mcp & agents first (all referenced by chats via
  // FK — `chat_on_demand_agents` references `agents`), then chats, messages,
  // chat-modes. FK enforcement is off during migrations (see initDatabase), so
  // this ordering is belt-and-suspenders, not the sole guard.
  migrateProviders(sqlite)
  migrateMcp(sqlite)
  migrateAgents(sqlite)
  migrateChats(sqlite)
  migrateMessages(sqlite)
  migrateChatModes(sqlite)
  // Account-provisioned (Cinna-managed) provider/mode columns + overrides table.
  // Must come after providers + chat-modes tables exist.
  migrateAccountConfig(sqlite)
  migrateAgentOverrides(sqlite)
  migrateA2aSessions(sqlite)
  migrateChatFiles(sqlite)
  // Jobs depend on chats + mcp_providers being present (FK references).
  migrateJobs(sqlite)
  migrateNotes(sqlite)
  migrateAppSettings(sqlite)
  // Sync bookkeeping tables (must come after notes/jobs exist).
  runSyncMigrations(sqlite)
  // Portable-dependency-sync columns (jobs.sync_deps + created_by_sync flags).
  runSyncDepsMigrations(sqlite)
  // Backfill `user_id` on legacy tables — must run AFTER table creation so
  // fresh installs don't ALTER tables that don't exist yet.
  migrateUserIdColumns(sqlite)
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return db
}

/** Raw better-sqlite3 handle, for repos that issue hand-written SQL (sync). */
export function getRawSqlite(): Database.Database {
  return sqlite
}
