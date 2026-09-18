import type Database from 'better-sqlite3'
import { hasColumn, hasTable } from './helpers'
import { DEFAULT_USER_ID } from '../../../shared/userIds'

export function migrateAppSettings(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}

/**
 * Marker row for {@link backfillAiFunctionsCredential}. Not an
 * `AppSettingsSchema` key, so `appSettingsRepo.getAll` never surfaces it.
 */
export const AI_FUNCTIONS_BACKFILL_MARKER = '__migration.aiFunctionsCredentialBackfill'

/**
 * One-time upgrade step for the runtime-conductor change. Before it, AI
 * Functions (titles, drafts) ran on the default chat mode's credential; now an
 * empty `aiFunctionsCredentialId` means the Default runtime. An install that
 * never chose an AI Functions credential is moved back onto the credential its
 * default chat mode used, so the upgrade does not silently change where titles
 * run.
 *
 * Runs exactly once per database: the marker row is written on every path,
 * fresh installs included, so a user who later clears the setting back to the
 * Default runtime is never backfilled again. Only a missing setting row counts
 * as "never chose" — a stored `""` is an explicit Default-runtime choice.
 * Reads the Default-scope (user-created) default mode: the profile whose
 * managed modes would outrank it is not known at boot.
 */
export function backfillAiFunctionsCredential(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'app_settings')) return
  const done = sqlite.prepare('SELECT 1 AS done FROM app_settings WHERE key = ?').get(AI_FUNCTIONS_BACKFILL_MARKER)
  if (done) return
  const now = Math.floor(Date.now() / 1000)
  const put = (key: string, value: string): void => {
    sqlite
      .prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(value), now)
  }
  const chosen = sqlite.prepare('SELECT 1 AS chosen FROM app_settings WHERE key = ?').get('aiFunctionsCredentialId')
  if (!chosen && hasTable(sqlite, 'chat_modes') && hasTable(sqlite, 'llm_providers')) {
    const scoped = hasColumn(sqlite, 'chat_modes', 'user_id')
    const mode = sqlite
      .prepare(
        `SELECT provider_id AS providerId, model_id AS modelId FROM chat_modes
         WHERE is_default = 1 AND provider_id IS NOT NULL AND provider_id != ''
         ${scoped ? 'AND user_id = ?' : ''}
         ORDER BY created_at LIMIT 1`
      )
      .get(...(scoped ? [DEFAULT_USER_ID] : [])) as { providerId: string; modelId: string | null } | undefined
    const provider = mode
      ? (sqlite
          .prepare(
            `SELECT default_model_id AS defaultModelId, available_models AS availableModels
             FROM llm_providers WHERE id = ? AND enabled = 1
             ${hasColumn(sqlite, 'llm_providers', 'unsupported') ? 'AND unsupported = 0' : ''}`
          )
          .get(mode.providerId) as { defaultModelId: string | null; availableModels: string | null } | undefined)
      : undefined
    if (mode && provider) {
      put('aiFunctionsCredentialId', mode.providerId)
      if (mode.modelId && providerOffersModel(provider, mode.modelId)) put('aiFunctionsModelId', mode.modelId)
    }
  }
  put(AI_FUNCTIONS_BACKFILL_MARKER, 'done')
}

function providerOffersModel(
  provider: { defaultModelId: string | null; availableModels: string | null },
  modelId: string
): boolean {
  if (provider.defaultModelId === modelId) return true
  try {
    const models: unknown = provider.availableModels ? JSON.parse(provider.availableModels) : []
    return Array.isArray(models) && models.includes(modelId)
  } catch {
    return false
  }
}
