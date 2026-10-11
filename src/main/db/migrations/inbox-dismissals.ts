import type Database from 'better-sqlite3'

/**
 * `inbox_dismissals` — Inbox cards the user dismissed, per profile.
 *
 * A row is `(user_id, kind, item_key)`: the card's kind
 * (`skill_disconnected`) and the key its computation derives (an agent, a
 * package and a pinned revision). The card's own computation clears a row
 * once the state it was dismissed in is over, so a later occurrence shows a
 * new card. No foreign key: `item_key` names an agent folder's id and a
 * catalog package, neither of which is a row here. Creation only, no DML.
 */
export function migrateInboxDismissals(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbox_dismissals (
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, item_key)
    );
  `)
}
