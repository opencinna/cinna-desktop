import type Database from 'better-sqlite3'
import { hasTable } from './helpers'

/**
 * `messages_search` — the all-chats search index (`chatRepo.searchMessages`):
 * an FTS5 trigram index over the `content` of the user's and the assistant's
 * messages, the only rows search reads. Contentless (`content=''`), so the text
 * is not stored twice; `contentless_delete=1`, so a row is removed by rowid
 * alone. `case_sensitive 0` folds case by Unicode (Cyrillic, Greek, accented
 * Latin), the way the renderer's `toLowerCase()` does; diacritics are kept
 * (`ecole` does not find `École`), as the renderer keeps them.
 *
 * Each index row's rowid is the message's implicit `messages.rowid`. Three
 * triggers keep it in step: insert, delete (an `ON DELETE CASCADE` from
 * `chats` fires it too) and an update of `content` or `role` — the running
 * turn's draft is rewritten in place every two seconds. Every write path to
 * `messages` is a plain INSERT / UPDATE / DELETE; there is no `INSERT OR
 * REPLACE` (whose implicit delete fires no delete trigger without
 * `recursive_triggers`), no table rebuild after this point and no `VACUUM`.
 * Adding any of those breaks the index silently: a REPLACE leaves a stale row,
 * a create-copy-drop-rename of `messages` drops the triggers and renumbers the
 * rowids, and so can `VACUUM` (the rowids are implicit, not an INTEGER PRIMARY
 * KEY). Such a change must drop `messages_search` so this migration rebuilds it.
 *
 * Runs after every migration that alters `messages`. Idempotent: the table and
 * the triggers are created when missing, and the existing rows are copied in
 * only when the table was just created (synchronous, once, at boot), all in
 * one transaction.
 */
export function migrateMessagesSearch(sqlite: Database.Database): void {
  // One transaction: a crash mid-backfill must not leave a table that the next
  // boot takes as built, with every older message missing from search.
  sqlite.transaction(() => {
    const created = !hasTable(sqlite, 'messages_search')
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_search USING fts5(
        content,
        content='',
        contentless_delete=1,
        tokenize='trigram case_sensitive 0'
      );

      CREATE TRIGGER IF NOT EXISTS messages_search_ai AFTER INSERT ON messages
      WHEN new.role IN ('user', 'assistant')
      BEGIN
        INSERT INTO messages_search(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_search_ad AFTER DELETE ON messages
      WHEN old.role IN ('user', 'assistant')
      BEGIN
        DELETE FROM messages_search WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_search_au AFTER UPDATE OF content, role ON messages
      BEGIN
        DELETE FROM messages_search WHERE rowid = old.rowid AND old.role IN ('user', 'assistant');
        INSERT INTO messages_search(rowid, content)
          SELECT new.rowid, new.content WHERE new.role IN ('user', 'assistant');
      END;
    `)
    if (created) {
      sqlite.exec(`
        INSERT INTO messages_search(rowid, content)
          SELECT rowid, content FROM messages WHERE role IN ('user', 'assistant');
      `)
    }
  })()
}
