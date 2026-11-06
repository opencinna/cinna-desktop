import type Database from 'better-sqlite3'

/**
 * `brand_themes` + `brand_theme_assets` — the last good brand theme each Cinna
 * server published, kept so a profile switch or a restart with the server
 * unreachable applies it at once (README B9). One row per server **origin**
 * (B1: one theme per server, shared by every profile on it), holding the
 * served document as JSON; its assets live once each by sha256 and are pruned
 * when no row references them. No foreign key: a cache, rebuilt by the next
 * refresh. Creation only, no DML.
 */
export function migrateBrandThemes(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS brand_themes (
      origin TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      etag TEXT,
      theme_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brand_theme_assets (
      sha256 TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL
    );
  `)
}
