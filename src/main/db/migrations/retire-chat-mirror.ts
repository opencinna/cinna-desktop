import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'

/** After router backfill: retain routing, retire the legacy compatibility mirror. */
export function migrateRetireChatMirror(sqlite: Database.Database): void {
  if (hasTable(sqlite, 'chats') && hasColumn(sqlite, 'chats', 'router') &&
      hasColumn(sqlite, 'chats', 'orchestrated')) {
    sqlite.exec('ALTER TABLE chats DROP COLUMN orchestrated')
  }
}
