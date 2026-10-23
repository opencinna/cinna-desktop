/**
 * How every Claude-engine session on this machine authenticates: the user's own
 * `claude` login (**subscription**, the default) or an Anthropic AI credential
 * this app holds (**API token**).
 *
 * A machine setting (`claudeAuthMode`, `claudeApiCredentialId`), never part of
 * an agent folder: which account pays for a turn is a property of this
 * computer, like the Default runtime. Shared so the Settings row that offers
 * the choice and the main-process resolver that spends the key agree on which
 * credentials qualify — the same reason `shared/credentials` exists.
 */
import { isCredentialActive, type UsableCredential } from './credentials'

export type ClaudeAuthMode = 'subscription' | 'api_key'

export const DEFAULT_CLAUDE_AUTH_MODE: ClaudeAuthMode = 'subscription'

export function isClaudeAuthMode(value: unknown): value is ClaudeAuthMode {
  return value === 'subscription' || value === 'api_key'
}

/** As much of a credential as the pick needs. */
export interface ClaudeApiCredentialCandidate extends UsableCredential {
  id: string
  enabled: boolean
}

/**
 * Whether a credential can carry Claude Agent turns in API mode: an Anthropic
 * row with a key, switched on, and not an account-provisioned OAuth token
 * (`unsupported`), which the Messages API refuses. Admin-shared managed rows
 * count — they are `enabled` and keyed like a user's own.
 */
export function isClaudeApiCredential(provider: ClaudeApiCredentialCandidate): boolean {
  return provider.type === 'anthropic' && provider.hasApiKey && isCredentialActive(provider)
}

/**
 * The credential API mode spends, or null when there is none to spend.
 *
 * `chosenId` is the setting: a named credential must still qualify, and when it
 * does not the answer is **null, not another key** — quietly billing a
 * different account than the one picked is the failure this setting exists to
 * prevent. Empty means automatic: `preferredId` (the Default AI credential)
 * when it is an Anthropic one, else the first that qualifies.
 */
export function pickClaudeApiCredential<T extends ClaudeApiCredentialCandidate>(
  providers: readonly T[],
  chosenId: string,
  preferredId: string | null
): T | null {
  const usable = providers.filter(isClaudeApiCredential)
  const chosen = chosenId.trim()
  if (chosen) return usable.find((provider) => provider.id === chosen) ?? null
  return (preferredId ? usable.find((provider) => provider.id === preferredId) : undefined) ?? usable[0] ?? null
}
