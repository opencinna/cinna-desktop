import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

export function migrateNotes(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled note',
      body TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);

    CREATE TABLE IF NOT EXISTS note_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_note_folders_user_id ON note_folders(user_id);
  `)

  // folder_id was added after the initial schema — guard with hasColumn so
  // re-runs on existing DBs don't crash.
  if (!hasColumn(sqlite, 'notes', 'folder_id')) {
    sqlite.exec(`ALTER TABLE notes ADD COLUMN folder_id TEXT`)
  }

  // Cleanup: permanently drop notes that have been in trash for over 30 days.
  // `deleted_at` is stored as Unix seconds, matching the chats cleanup.
  const thirtyDaysAgoSeconds = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000)
  sqlite.exec(
    `DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ${thirtyDaysAgoSeconds}`
  )
}
