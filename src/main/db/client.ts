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
import { migrateUsers } from './migrations/users'
import { migrateChatAgentSessions } from './migrations/chat-agent-sessions'
import { chatModeRepo } from './chatModes'
import { createLogger } from '../logger/logger'

const logger = createLogger('db')

let db: BetterSQLite3Database<typeof schema>
let sqlite: Database.Database

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'cinna.db')
  sqlite = new Database(dbPath)

  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  db = drizzle(sqlite, { schema })

  runMigrations()
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
  // Order matters: providers & mcp first (referenced by chats), then chats, messages, chat-modes
  migrateProviders(sqlite)
  migrateMcp(sqlite)
  migrateChats(sqlite)
  migrateMessages(sqlite)
  migrateChatModes(sqlite)
  migrateAgents(sqlite)
  migrateAgentOverrides(sqlite)
  migrateA2aSessions(sqlite)
  migrateChatAgentSessions(sqlite)
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return db
}
