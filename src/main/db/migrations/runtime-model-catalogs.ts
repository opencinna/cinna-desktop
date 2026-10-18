import type Database from 'better-sqlite3'

/**
 * `runtime_model_catalogs` — the models (and effort levels) a CLI runtime last
 * advertised, per profile (`user_id`) and runtime (`engine`): one JSON document
 * (`shared/runtimeModelCatalog`). Kept so the Advanced model picker and the
 * "no longer offered" warning have something true to say after a restart,
 * before any turn has run. No foreign key: a cache, rebuilt by the next session
 * or refresh. Creation only, no DML.
 */
export function migrateRuntimeModelCatalogs(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runtime_model_catalogs (
      user_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, engine)
    );
  `)
}
