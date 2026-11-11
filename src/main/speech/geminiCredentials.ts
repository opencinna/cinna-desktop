import { appSettingsRepo } from '../db/appSettings'
import { llmProviderRepo, type LlmProviderRow } from '../db/llmProviders'
import { getManagedResourceScopes } from '../auth/scope'
import { decryptApiKey } from '../security/keystore'
import { createLogger } from '../logger/logger'
import type { SpeechCloudProvider, VoiceCloudService, VoiceCloudTranscription } from '../../shared/speech'

const logger = createLogger('speech')

/** What cloud transcription is set to and can use, without decrypting anything. */
export interface CloudTranscriptionConfig {
  mode: VoiceCloudTranscription
  /** The Service setting (`''` = the Cinna server when its relay is available, else Gemini). Optional for older callers: absent is `''`. */
  service?: VoiceCloudService
  /** Usable Gemini providers, in repo order. */
  providers: SpeechCloudProvider[]
  /** The one a session would bill: the chosen id when usable, else the first. */
  chosen: SpeechCloudProvider | null
}

/** A Gemini key for one session, or why there is none. The key never leaves main and is never logged. */
export type GeminiKey =
  | { ok: true; apiKey: string; provider: SpeechCloudProvider }
  | { ok: false; message: string }

export const NO_GEMINI_PROVIDER_MESSAGE =
  'Transcribing with Gemini needs a Gemini provider with an API key. Add one in Settings › AI Credentials, or pick one in Settings › Features › Cloud transcription.'

/** Enabled, with a key, and not marked unsupported. */
function isUsableGemini(row: LlmProviderRow): boolean {
  return row.type === 'gemini' && row.enabled && !!row.apiKeyEncrypted && row.apiKeyEncrypted.length > 0 && !row.unsupported
}

function pick(rows: LlmProviderRow[], chosenId: string): LlmProviderRow | null {
  const usable = rows.filter(isUsableGemini)
  return usable.find((row) => row.id === chosenId) ?? usable[0] ?? null
}

/** Settings and provider rows, read fresh: what `speech:status` reports and a session decides on. */
export function readCloudConfig(): CloudTranscriptionConfig {
  const mode = appSettingsRepo.get('voiceCloudTranscription')
  const rows = llmProviderRepo.listByUserIds(getManagedResourceScopes())
  const providers = rows.filter(isUsableGemini).map((row) => ({ id: row.id, name: row.name }))
  const chosenRow = pick(rows, appSettingsRepo.get('voiceCloudProviderId'))
  return { mode, service: appSettingsRepo.get('voiceCloudService'), providers, chosen: chosenRow ? { id: chosenRow.id, name: chosenRow.name } : null }
}

/**
 * The chosen Gemini provider's key, decrypted for one session. A key that no
 * longer decrypts (the keychain entry was reset) is as unusable as a missing
 * one; the failure is logged without the key.
 */
export async function resolveGeminiKey(): Promise<GeminiKey> {
  let row: LlmProviderRow | null
  try {
    row = pick(llmProviderRepo.listByUserIds(getManagedResourceScopes()), appSettingsRepo.get('voiceCloudProviderId'))
  } catch (error) {
    logger.warn('could not read the Gemini providers for transcription', { error: error instanceof Error ? error.message : String(error) })
    return { ok: false, message: NO_GEMINI_PROVIDER_MESSAGE }
  }
  if (!row?.apiKeyEncrypted) return { ok: false, message: NO_GEMINI_PROVIDER_MESSAGE }
  try {
    const apiKey = await decryptApiKey(row.apiKeyEncrypted)
    if (!apiKey) return { ok: false, message: NO_GEMINI_PROVIDER_MESSAGE }
    return { ok: true, apiKey, provider: { id: row.id, name: row.name } }
  } catch (error) {
    logger.warn('Gemini transcription key could not be decrypted', { providerId: row.id, error: error instanceof Error ? error.message : String(error) })
    return { ok: false, message: `The API key of the Gemini provider ${row.name} could not be read. Enter it again in Settings › AI Credentials.` }
  }
}
