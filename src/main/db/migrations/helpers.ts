import type Database from 'better-sqlite3'

/** Check if a column exists on a table */
export function hasColumn(sqlite: Database.Database, table: string, column: string): boolean {
  const row = sqlite
    .prepare(`SELECT COUNT(*) as cnt FROM pragma_table_info('${table}') WHERE name='${column}'`)
    .get() as { cnt: number }
  return row.cnt > 0
}

/** Check if a table exists */
export function hasTable(sqlite: Database.Database, table: string): boolean {
  const row = sqlite
    .prepare(`SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='${table}'`)
    .get() as { cnt: number }
  return row.cnt > 0
}
