/**
 * Wire contract for the Cinna native account-config endpoint
 * (`GET /api/v1/external/account-config`) plus the desktop-side mapping helpers.
 *
 * The endpoint returns one descriptor per usable AI credential of the signed-in
 * user — INCLUDING the decrypted `api_key` — so the desktop can materialize
 * local LLM providers + a default chat mode per credential on login. Keep the
 * field names here in one place: the backend contract is still draft, so a shape
 * change should be a single-file edit. See
 * `workflow-runner-core/docs/plans/admin_ai_credential_provisioning_plan.md` §3.4
 * and `docs/llm/account_provisioning`.
 */

import type { ProviderType } from './factory'

/** Provider type as reported by cinna-core (superset of desktop adapters). */
export type AccountConfigProviderType =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openai_compatible'
  | 'minimax'

export interface AccountConfigProvider {
  credential_id: string
  provider_type: AccountConfigProviderType
  display_name: string
  /**
   * The credential's own free-form name on cinna-core (e.g. "Work Claude").
   * `display_name` is only the provider family ("Claude"/"OpenAI"/"Gemini"), so
   * it's identical across every credential of one provider — this disambiguates
   * them in the managed provider / chat-mode names. May be absent on older
   * servers; callers fall back to `display_name` alone.
   */
  credential_name?: string
  descriptor_slug: string
  base_url: string | null
  /**
   * Auto-resolved suggestion from cinna-core's legacy fallback chain. Can land
   * on a non-chat model (e.g. an embedding) for keys whose only signal is
   * `discovered_models` — prefer {@link default_model}. Still authoritative for
   * `openai_compatible`, where it carries the gateway's required model id.
   */
  model: string | null
  /**
   * The admin-curated preferred default model on cinna-core
   * (`credential.default_model`). Absent/null for self-created credentials with
   * no curation. When present this is the authoritative default the desktop uses
   * for the managed provider/mode. May be absent on older servers.
   */
  default_model?: string | null
  /** *** DECRYPTED *** — re-encrypted locally via safeStorage, never logged. */
  api_key: string
  is_default: boolean
  is_admin_managed: boolean
  default_chat_mode_label: string
  suggested_models: string[]
}

export interface AccountConfigResponse {
  providers: AccountConfigProvider[]
  default_provider_credential_id: string | null
  generated_at: string
}

/** Deterministic local ids so re-sync upserts the same rows. */
export const MANAGED_PROVIDER_PREFIX = 'managed:'
export const MANAGED_MODE_PREFIX = 'managed-mode:'

export function managedProviderId(credentialId: string): string {
  return `${MANAGED_PROVIDER_PREFIX}${credentialId}`
}
export function managedModeId(credentialId: string): string {
  return `${MANAGED_MODE_PREFIX}${credentialId}`
}
export function isManagedProviderId(id: string): boolean {
  return id.startsWith(MANAGED_PROVIDER_PREFIX)
}
export function isManagedModeId(id: string): boolean {
  return id.startsWith(MANAGED_MODE_PREFIX)
}

/**
 * Map a cinna-core provider type to a desktop adapter type. Returns null for
 * types we have no native adapter for (`minimax`) — the sync skips those with a
 * warning, mirroring remote-sync's skip-unknown-target behavior.
 */
export function mapToDesktopProviderType(t: AccountConfigProviderType): ProviderType | null {
  switch (t) {
    case 'anthropic':
      return 'anthropic'
    case 'openai':
      return 'openai'
    case 'google':
      return 'gemini'
    case 'openai_compatible':
      return 'openai_compatible'
    default:
      return null // minimax + any future unknowns
  }
}

/**
 * Color preset for a managed chat mode, by desktop provider type — mirrors the
 * onboarding provider→color choice (Anthropic→amber, OpenAI→emerald,
 * Gemini→sky) so managed modes look consistent with hand-created ones.
 */
/**
 * Build the display name for a managed provider / chat mode, disambiguating
 * multiple credentials of the same provider family by appending the credential's
 * own name: `"Claude"` + `"Work Key"` → `"Claude (Work Key)"`.
 *
 * Returns the base name unchanged when there's no distinct credential name —
 * absent/blank, or equal to the base (e.g. `openai_compatible`, whose
 * `display_name` already *is* the credential name) — so single-key setups stay
 * clean ("Claude", not "Claude (Claude)").
 */
export function managedDisplayName(baseName: string, credentialName?: string): string {
  const base = (baseName ?? '').trim()
  const cred = (credentialName ?? '').trim()
  if (!cred || cred.toLowerCase() === base.toLowerCase()) return base
  return `${base} (${cred})`
}

export function colorPresetForType(t: ProviderType): string {
  switch (t) {
    case 'anthropic':
      return 'amber'
    case 'openai':
      return 'emerald'
    case 'gemini':
      return 'sky'
    case 'openai_compatible':
      return 'violet'
    default:
      return 'slate'
  }
}
