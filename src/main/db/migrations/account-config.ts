import type Database from 'better-sqlite3'
import { hasColumn } from './helpers'

/**
 * Schema for account-provisioned (Cinna-managed) LLM providers and chat modes:
 *   - `llm_providers.base_url`  — endpoint for `openai_compatible` gateways.
 *   - `llm_providers.available_models` — curated picker list (`suggested_models`).
 *   - `llm_providers.managed`   — marks a row as sync-owned + read-only.
 *   - `llm_providers.unsupported` — managed credential unusable for API calls
 *                                 (anthropic `sk-ant-oat` token): shown with a
 *                                 "Not supported" badge, no adapter, no chat mode.
 *   - `chat_modes.managed`      — same marker for the per-credential default mode.
 *   - `managed_overrides`       — per-profile local enable/disable preference
 *                                 (no FK / cascade, survives re-sync — mirrors
 *                                 `agent_overrides`). The `model_id` column holds
 *                                 a per-mode model choice that overrides the
 *                                 synced default (also re-sync-proof).
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
  if (!hasColumn(sqlite, 'llm_providers', 'unsupported')) {
    // Managed credential that can't make API calls (e.g. Anthropic `sk-ant-oat`
    // OAuth token) — shown in the list with a "Not supported" badge, no adapter,
    // no auto chat mode.
    sqlite.exec(`ALTER TABLE llm_providers ADD COLUMN unsupported INTEGER NOT NULL DEFAULT 0`)
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
  // Per-mode model override (null = use the synced default). Added after the
  // table so existing installs gain the column without recreating the table.
  if (!hasColumn(sqlite, 'managed_overrides', 'model_id')) {
    sqlite.exec(`ALTER TABLE managed_overrides ADD COLUMN model_id TEXT`)
  }
}
