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
import { migrateUsers } from './migrations/users'

let db: BetterSQLite3Database<typeof schema>
let sqlite: Database.Database

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'cinna.db')
  sqlite = new Database(dbPath)

  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  db = drizzle(sqlite, { schema })

  runMigrations()
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
  migrateA2aSessions(sqlite)
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return db
}
