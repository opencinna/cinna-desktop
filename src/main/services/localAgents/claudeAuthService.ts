/**
 * Which account pays for a Claude-engine turn on this machine: the user's own
 * `claude` login, or the Anthropic AI credential picked in Settings → Local
 * Agents (`claudeAuthMode` / `claudeApiCredentialId`, `shared/claudeAuthMode.ts`).
 *
 * Core: no Electron. The key is decrypted here, in main, only to be handed to
 * `buildClaudeEnv`; it never leaves this process, a log line or a spec key
 * (only a digest of it, as the {@link ClaudeLaunchAuth} fingerprint).
 *
 * **API mode never falls back.** No qualifying credential — none at all, the
 * named one gone or switched off, a key the keystore will not decrypt — is an
 * `error` the launcher turns into a refused turn. Running on the subscription
 * instead would bill an account the user just told us not to use.
 */
import { createHash } from 'node:crypto'
import { appSettingsService } from '../appSettingsService'
import { providerService, type ProviderDto } from '../providerService'
import { llmProviderRepo } from '../../db/llmProviders'
import { getManagedResourceScopes } from '../../auth/scope'
import { decryptApiKey } from '../../security/keystore'
import { runtimeService } from './runtimeService'
import { createLogger } from '../../logger/logger'
import { isClaudeAuthMode, pickClaudeApiCredential, type ClaudeAuthMode } from '../../../shared/claudeAuthMode'
import type { ClaudeLaunchAuth } from '../../agents/drivers/acp/claudeEnv'

const logger = createLogger('claude-auth-mode')

export const SUBSCRIPTION_FINGERPRINT = 'subscription'

export const CLAUDE_API_NO_CREDENTIAL =
  'Claude Agent is set to use an API token, but no Anthropic AI credential is available. Add one in Settings → AI Credentials, or choose Subscription in Settings → Local Agents.'
export const CLAUDE_API_CREDENTIAL_GONE =
  'The Anthropic credential chosen for Claude Agent is no longer available. Choose another one, or Subscription, in Settings → Local Agents.'
export const CLAUDE_API_KEY_UNREADABLE =
  'The Anthropic API key chosen for Claude Agent could not be read. Re-enter it in Settings → AI Credentials, or choose Subscription in Settings → Local Agents.'

export interface ClaudeAuthServiceDeps {
  settings(): { claudeAuthMode: string; claudeApiCredentialId: string }
  providers(): ProviderDto[]
  /** The Default AI credential's id, preferred when it is Anthropic. */
  preferredCredentialId(): string | null
  /** The stored key and endpoint of one credential, decrypted. Throws when it cannot be read. */
  secret(providerId: string): Promise<{ apiKey: string; baseUrl: string | null } | null>
}

const productionDeps: ClaudeAuthServiceDeps = {
  settings: () => appSettingsService.getAll(),
  providers: () => providerService.listMerged(),
  preferredCredentialId: () => {
    try {
      return runtimeService.resolveDefault().credentialId ?? null
    } catch {
      return null
    }
  },
  secret: async (providerId) => {
    for (const scope of getManagedResourceScopes()) {
      const row = llmProviderRepo.getOwned(scope, providerId)
      if (!row) continue
      if (!row.apiKeyEncrypted) return null
      return { apiKey: await decryptApiKey(row.apiKeyEncrypted), baseUrl: row.baseUrl ?? null }
    }
    return null
  }
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
}

export function createClaudeAuthService(deps: ClaudeAuthServiceDeps = productionDeps) {
  const mode = (): ClaudeAuthMode => {
    try {
      const value = deps.settings().claudeAuthMode
      return isClaudeAuthMode(value) ? value : 'subscription'
    } catch {
      return 'subscription'
    }
  }

  const resolve = async (): Promise<ClaudeLaunchAuth> => {
    if (mode() !== 'api_key') return { mode: 'subscription', fingerprint: SUBSCRIPTION_FINGERPRINT }
    const chosenId = (() => {
      try { return deps.settings().claudeApiCredentialId.trim() } catch { return '' }
    })()
    let providers: ProviderDto[]
    try {
      providers = deps.providers()
    } catch {
      providers = []
    }
    const credential = pickClaudeApiCredential(providers, chosenId, chosenId ? null : deps.preferredCredentialId())
    if (!credential) {
      return {
        mode: 'api_key',
        fingerprint: `api_key:none:${digest([chosenId])}`,
        error: chosenId ? CLAUDE_API_CREDENTIAL_GONE : CLAUDE_API_NO_CREDENTIAL
      }
    }
    let secret: { apiKey: string; baseUrl: string | null } | null
    try {
      secret = await deps.secret(credential.id)
    } catch (err) {
      logger.warn('the Anthropic credential for Claude Agent would not decrypt', {
        providerId: credential.id,
        error: err instanceof Error ? err.message : String(err)
      })
      secret = null
    }
    if (!secret?.apiKey) {
      return { mode: 'api_key', fingerprint: `api_key:unreadable:${digest([credential.id])}`, error: CLAUDE_API_KEY_UNREADABLE }
    }
    return {
      mode: 'api_key',
      // Mode, credential, key and endpoint: a rotated key moves it too.
      fingerprint: `api_key:${digest([credential.id, secret.apiKey, secret.baseUrl ?? ''])}`,
      credential: { apiKey: secret.apiKey, baseUrl: secret.baseUrl }
    }
  }

  return {
    mode,
    /** How the next Claude launch authenticates. Decrypts in API mode; never throws. */
    resolve,
    /** The non-secret digest of {@link resolve}, for pool keys. */
    fingerprint: async (): Promise<string> => (await resolve()).fingerprint
  }
}

export type ClaudeAuthService = ReturnType<typeof createClaudeAuthService>

export const claudeAuthService = createClaudeAuthService()
