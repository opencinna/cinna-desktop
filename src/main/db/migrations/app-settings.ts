import type Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

/**
 * Keep an existing install's agents home where it is.
 *
 * The built-in default moved from `~/Documents/CinnaAgents` to `~/CinnaAgents`
 * (`services/localAgents/homePath.ts`): `~/Documents` is guarded on macOS, and
 * creating the default there raised the system's Documents prompt. An empty
 * `localAgentsHome` means "the default", so an install that has been using the
 * old one would, after the move, have its home root repointed at a new empty
 * folder by `ensureHome`'s "home moved" branch, and every agent would vanish
 * from the sidebar.
 *
 * So when the setting is missing or empty **and** a default root is registered
 * at exactly the old default path, that path is written into the setting. A
 * fresh install has no such row and stays on the new default.
 *
 * Strings only: the old path is built with `join(homedir(), …)`, the same way
 * the old default was, and compared with the stored row. Nothing is read or
 * statted inside `~/Documents` — that is the read that raises the prompt.
 * Idempotent with no marker: once the setting holds the path, the condition no
 * longer matches. The written value is the same string the acknowledgement and
 * the root row are keyed by, so a guarded home this install already uses
 * reports `ready` exactly as before. `configuredHomePath` returns this exact
 * value without `assertUsableRoot`, as it did while it was the default — so a
 * `~/Documents` redirected outside the allowed bases keeps working.
 */
export function pinLegacyAgentsHome(sqlite: Database.Database, home: string = homedir()): void {
  if (!hasTable(sqlite, 'app_settings') || !hasTable(sqlite, 'agent_roots')) return
  const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get('localAgentsHome') as
    | { value: string }
    | undefined
  if (row) {
    // Read as `appSettingsRepo.get` reads it: a corrupt or non-string value is
    // the default there, so it counts as empty here.
    let current: unknown = ''
    try {
      current = JSON.parse(row.value)
    } catch {
      /* corrupt: the default */
    }
    if (typeof current === 'string' && current.trim() !== '') return
  }
  const legacy = join(home, 'Documents', 'CinnaAgents')
  const root = sqlite.prepare('SELECT 1 AS found FROM agent_roots WHERE is_default = 1 AND path = ? LIMIT 1').get(legacy)
  if (!root) return
  sqlite
    .prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('localAgentsHome', JSON.stringify(legacy), Math.floor(Date.now() / 1000))
}

/** Marker row for {@link pinVoiceCloudService}; not an `AppSettingsSchema` key. */
export const VOICE_CLOUD_SERVICE_PIN_MARKER = '__migration.voiceCloudServicePin'

/** A stored setting as `appSettingsRepo.get` reads it: missing, corrupt or not a string is `fallback`. */
function storedString(sqlite: Database.Database, key: string, fallback: string): string {
  const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    const parsed: unknown = JSON.parse(row.value)
    return typeof parsed === 'string' ? parsed : fallback
  } catch {
    return fallback
  }
}

/**
 * One-time upgrade step for the Cinna server transcription relay. Before it,
 * cloud transcription had one service, the user's own Gemini key; an install
 * with a cloud mode on consented to exactly that. The new Service setting's
 * empty value would let a session move to the Cinna server when the relay
 * appears and back to the billed key when it goes, so such an install is
 * pinned to `gemini`. The settings store is installation-global: one scope.
 *
 * Runs once per database (the marker is written on every path, fresh
 * installs included): afterwards Settings saves the service together with the
 * mode, and an empty service with a mode on never runs on Gemini, so a later
 * empty value must not be read as consent to the key.
 */
export function pinVoiceCloudService(sqlite: Database.Database): void {
  if (!hasTable(sqlite, 'app_settings')) return
  const done = sqlite.prepare('SELECT 1 AS done FROM app_settings WHERE key = ?').get(VOICE_CLOUD_SERVICE_PIN_MARKER)
  if (done) return
  const now = Math.floor(Date.now() / 1000)
  const mode = storedString(sqlite, 'voiceCloudTranscription', 'off')
  const service = storedString(sqlite, 'voiceCloudService', '')
  if ((mode === 'fallback' || mode === 'always') && service === '') {
    sqlite
      .prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('voiceCloudService', JSON.stringify('gemini'), now)
  }
  sqlite
    .prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(VOICE_CLOUD_SERVICE_PIN_MARKER, JSON.stringify('done'), now)
}
