import type Database from 'better-sqlite3'

/**
 * SQL functions the all-chats search needs on every connection
 * (`chatRepo.searchMessages`). Registered by `initDatabase` and by the test
 * database, both through the same `better-sqlite3`-shaped handle.
 */

/** `cinna_contains_folded(content, foldedQuery)`: 1 when `content` lowercased contains `foldedQuery`. */
export const CONTAINS_FOLDED = 'cinna_contains_folded'

/**
 * Case folding as the renderer's in-chat search does it (`toLowerCase()`, so
 * Cyrillic, Greek and accented letters fold, diacritics stay); `foldedQuery`
 * is lowered by the caller once, not per row. Used for queries too short for
 * the trigram index.
 */
export function containsFolded(content: unknown, foldedQuery: unknown): number {
  if (typeof content !== 'string' || typeof foldedQuery !== 'string') return 0
  return content.toLowerCase().includes(foldedQuery) ? 1 : 0
}

export function registerSearchFunctions(sqlite: Database.Database): void {
  sqlite.function(CONTAINS_FOLDED, { deterministic: true }, containsFolded)
}
