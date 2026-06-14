import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * Schema for account-provisioned (Cinna-managed) LLM providers and chat modes:
 *   - `llm_providers.base_url`  — endpoint for `openai_compatible` gateways.
 *   - `llm_providers.available_models` — curated picker list (`suggested_models`).
 *   - `llm_providers.managed`   — marks a row as sync-owned + read-only.
 *   - `chat_modes.managed`      — same marker for the per-credential default mode.
 *   - `managed_overrides`       — per-profile local enable/disable preference
 *                                 (no FK / cascade, survives re-sync — mirrors
 *                                 `agent_overrides`).
 *
 * Runs after providers/chat-modes migrations created their base tables.
 */
export function migrateAccountConfig(sqlite: Database.Database): void {
  if (!hasColumn(sqlite, 'llm_providers', 'base_url')) {
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN base_url TEXT`)
  }
  if (!hasColumn(sqlite, 'llm_providers', 'managed')) {
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN managed INTEGER NOT NULL DEFAULT 0`)
  }
  if (!hasColumn(sqlite, 'llm_providers', 'admin_managed')) {
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN admin_managed INTEGER NOT NULL DEFAULT 0`)
  }
  if (!hasColumn(sqlite, 'llm_providers', 'available_models')) {
    // JSON array of curated model ids (account-config `suggested_models`).
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN available_models TEXT`)
  }
  if (!hasColumn(sqlite, 'chat_modes', 'managed')) {
    sqlite.exec(`ALTER TABLE chat_modes ADD COLUMN managed INTEGER NOT NULL DEFAULT 0`)
  }
  if (!hasColumn(sqlite, 'chat_modes', 'admin_managed')) {
    sqlite.exec(`ALTER TABLE chat_modes ADD COLUMN admin_managed INTEGER NOT NULL DEFAULT 0`)
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS managed_overrides (
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, resource_id)
    );
  `)
}
