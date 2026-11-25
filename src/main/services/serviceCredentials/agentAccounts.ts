/**
 * `service-credentials:unavailable-accounts`: the Cinna accounts a local folder agent takes
 * credentials from that cannot supply them now, one answer per agent, for the composer's warning
 * rows. Two kinds of credential are account-bound:
 *
 * - attached Core credentials (agent and skill slots, Google OAuth included), stored per account
 *   key and delivered only while that account is eligible (`serviceCredentialService.unavailableAccounts`);
 * - account-provisioned AI credentials (`managed:{credentialId}` provider rows), which exist only
 *   in their profile's scope: an OpenCode agent's `runtime.credential`, the machine pin
 *   (`localAgentsDefaultCredentialId`) when nothing else resolves, and Claude API Token mode's
 *   `claudeApiCredentialId`, when the reference resolves to nothing here but names another
 *   profile's managed row.
 *
 * Core: no Electron. Never throws for an expected state; vault agents answer no accounts.
 */
import { findCredentialByReference } from '../../../shared/credentials'
import { effectiveEngine, type AgentEngine } from '../../../shared/engine'
import { pickClaudeApiCredential } from '../../../shared/claudeAuthMode'
import type { LocalAgentDto } from '../../../shared/localAgents'
import type { AgentCredentialAccounts, UnavailableCredentialAccount } from '../../../shared/serviceCredentials'
import { managedCredentialOwner, withAiCredentialOwner, type ProviderOwnerRow } from './accountAvailability'
import type { ProviderDto } from '../providerService'

export interface AgentAccountsDeps {
  isVault(id: string): boolean
  agent(id: string): Pick<LocalAgentDto, 'runtime'>
  /** The agent's attached Core credentials' unavailable accounts. */
  credentialAccounts(id: string): UnavailableCredentialAccount[]
  /** A profile as an unavailable account for its AI credential; null for the current profile. */
  profileAccount(userId: string): UnavailableCredentialAccount | null
  defaultEngine(): AgentEngine
  /** The AI credentials this profile can spend (Default scope and the current profile's managed rows). */
  providers(): ProviderDto[]
  /** What the Default runtime resolves to without an agent of its own: the pin, else the default chat mode's credential. */
  fallbackCredentialId(providers: ProviderDto[]): string | null
  settings(): { localAgentsDefaultCredentialId: string; claudeAuthMode: string; claudeApiCredentialId: string }
  /** Managed provider rows of every profile but the current one. */
  otherManagedRows(): ProviderOwnerRow[]
}

/**
 * The reference the agent's AI credential is looked up by when it resolves to nothing here, as
 * the engine resolves it (`runtimeService.resolve`, `claudeAuthService.resolve`); null when it
 * resolves, or the engine spends none of this app's credentials.
 */
type AiLookup = (
  runtime: LocalAgentDto['runtime'],
  providers: readonly ProviderDto[],
  fallbackCredentialId: () => string | null,
  settings: ReturnType<AgentAccountsDeps['settings']>
) => { reference: string; byId: boolean } | null

/** The pin, when it names a credential this profile does not have. */
function gonePin(providers: readonly ProviderDto[], settings: ReturnType<AgentAccountsDeps['settings']>): string | null {
  const pin = settings.localAgentsDefaultCredentialId.trim()
  return pin !== '' && !providers.some((p) => p.id === pin) ? pin : null
}

/**
 * Per engine that spends one of this app's AI credentials, how its unresolved reference is found;
 * Codex and Antigravity run on their own logins and spend none.
 */
const AI_LOOKUP: Partial<Record<AgentEngine, AiLookup>> = {
  // `runtimeService.resolve`: the agent's own reference, else the pin, else the default chat mode's.
  opencode: (runtime, providers, fallbackCredentialId, settings) => {
    const declared = typeof runtime?.credential === 'string' ? runtime.credential.trim() : ''
    if (declared !== '') return findCredentialByReference(providers, declared) ? null : { reference: declared, byId: false }
    // A pin naming nothing falls through to the default chat mode; only when that resolves to nothing too is the agent without one.
    const pin = gonePin(providers, settings)
    return pin !== null && fallbackCredentialId() === null ? { reference: pin, byId: true } : null
  },
  // `claudeAuthService.resolve`: only in API Token mode, the chosen credential (never another), else the pin.
  claude: (_runtime, providers, _fallback, settings) => {
    if (settings.claudeAuthMode !== 'api_key') return null
    const chosen = settings.claudeApiCredentialId.trim()
    // A chosen credential that exists here but is switched off is not an account's to explain.
    if (chosen !== '') return providers.some((p) => p.id === chosen) ? null : { reference: chosen, byId: true }
    const pin = gonePin(providers, settings)
    return pin !== null && pickClaudeApiCredential(providers, '', null) === null ? { reference: pin, byId: true } : null
  }
}

/**
 * The reference the agent's AI credential is looked up by when it resolves to nothing here, as
 * the engine resolves it (`runtimeService.resolve`, `claudeAuthService.resolve`); null when it
 * resolves, or the engine spends none of this app's credentials.
 */
export function unresolvedAiReference(
  runtime: LocalAgentDto['runtime'],
  engine: AgentEngine,
  providers: readonly ProviderDto[],
  fallbackCredentialId: () => string | null,
  settings: ReturnType<AgentAccountsDeps['settings']>
): { reference: string; byId: boolean } | null {
  return AI_LOOKUP[engine]?.(runtime, providers, fallbackCredentialId, settings) ?? null
}

export function createAgentAccounts(deps: AgentAccountsDeps) {
  return {
    /** The agent's unavailable accounts, attached credentials first, the AI credential's owner folded in. */
    unavailable(id: string): AgentCredentialAccounts {
      if (deps.isVault(id)) return { accounts: [] }
      const a = deps.agent(id)
      const credentials = deps.credentialAccounts(id)
      let owner: UnavailableCredentialAccount | null = null
      const providers = deps.providers()
      const settings = deps.settings()
      const ref = unresolvedAiReference(a.runtime ?? null, effectiveEngine(a.runtime ?? null, deps.defaultEngine()), providers, () => deps.fallbackCredentialId(providers), settings)
      const row = ref ? managedCredentialOwner(ref.reference, deps.otherManagedRows(), ref.byId) : null
      if (row) owner = deps.profileAccount(row.userId)
      return { accounts: withAiCredentialOwner(credentials, owner) }
    }
  }
}
