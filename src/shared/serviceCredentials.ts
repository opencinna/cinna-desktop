/** Service values are write-only. Renderer reads metadata and attachment state. */
export const SERVICE_CREDENTIALS_CHANGED = 'service-credentials:changed'
export const LOCAL_CREDENTIAL_TYPES = ['api_token', 'email_imap', 'email_smtp', 'odoo', 'google_service_account'] as const
export type LocalCredentialType = typeof LOCAL_CREDENTIAL_TYPES[number]
/** Status of an issued Agent API key, as Core computes it. Only `active` delivers a token. */
export const AGENT_API_KEY_STATUSES = ['active', 'revoked_by_issuer', 'producer_removed', 'issuer_removed', 'expired', 'api_disabled', 'external_access_paused'] as const
export type AgentApiKeyStatus = typeof AGENT_API_KEY_STATUSES[number]
/** Statuses that recover by themselves (the key stays attachable and polled). */
export const AGENT_API_KEY_PAUSED_STATUSES: readonly string[] = ['api_disabled', 'external_access_paused']
/** Non-secret facts about an issued key, for display only. */
export interface AgentApiKeyInfo { producerName: string | null; issuerEmail: string | null }
export interface ServiceCredentialDto {
  id: string; origin: 'local' | 'cloud'; cloudId: string | null
  name: string; type: string; serviceUri: string | null; notes: string | null
  status: string; isPlaceholder: boolean; relation: 'owned' | 'shared'
  ownerEmail: string | null; localUseAllowed: boolean; revision: string | null
  hasValues: boolean; expiresAt: number | null
  /** Issued Agent API key status; null for every other type. Unknown future values pass through and read as unavailable. */
  keyStatus: AgentApiKeyStatus | (string & {}) | null
  /** Producer/issuer facts for an issued key when Core sends them; null otherwise. */
  agentApi: AgentApiKeyInfo | null
  /** Set when Desktop refused to store an issued key's delivery (`insecure_base_url`); null otherwise. Not secret. */
  keyBlocked: 'insecure_base_url' | (string & {}) | null
}
export interface ServiceCredentialInput {
  id?: string; name: string; type: LocalCredentialType; serviceUri?: string; notes?: string
  values?: Record<string, unknown>
}
export interface ServiceCredentialAttachments {
  local: { ref: string }[]
  accounts: Record<string, { ref: string }[]>
}
export interface ServiceCredentialAttachmentDto {
  ref: string; origin: 'local' | 'cloud'
  /** `'local'` or the account key the reference is stored under. */
  group: string
  /** "This computer", the profile name, or "Signed-out account" when that account is not eligible. */
  groupLabel: string
  credential: ServiceCredentialDto | null
  state: ServiceCredentialAttachmentState
  /** The account's Cinna server, for the per-credential Manage link. Null for local references and unavailable accounts. */
  serverUrl: string | null
  /** The account the group belongs to, for its "Name <email> host" heading. Null for local references and unavailable accounts. */
  account: { name: string; email: string } | null
}
export type ServiceCredentialAttachmentState = 'ready' | 'missing' | 'incomplete' | 'local_use_not_allowed' | 'not_cached' | 'expired' | 'account_unavailable' | 'key_unavailable'
/** One attach-picker section: local records, or one eligible account's cache. */
export interface ServiceCredentialAttachGroup {
  key: string; label: string; detail: string; error: string | null
  items: (ServiceCredentialDto & { attached: boolean })[]
}
export interface ServiceCredentialAttachOptions { groups: ServiceCredentialAttachGroup[] }
export interface ServiceCredentialEntry {
  id: string; name: string; type: string; notes: string | null; service_uri: string | null
  is_placeholder: boolean; credential_data: Record<string, unknown>
  /** Set on a token-less issued-key entry: `key_revoked` | `key_expired` | `key_paused`. */
  unavailable_reason?: string; key_status?: string
}
export interface ServiceCredentialBundle {
  id: string; revision: string; entry: ServiceCredentialEntry
  service_account_file: Record<string, unknown> | null; ssh_key: null
}
/** A credential the Finish setup dialog offers for a slot: a record in the active profile's account. */
export interface CredentialSetupOption {
  /** The account key, as `setAttachments` takes it. */
  group: string
  /** Core's record id. */
  ref: string
  credential: ServiceCredentialDto
}
/**
 * One manifest credential slot, as the Finish setup dialog shows it. Names only, never a value.
 * `state` restates the scanner's verdict: `connected` and `env` are exactly the satisfied slots
 * (optional ones aside), so the dialog can never call ready what readiness calls missing.
 */
export interface CredentialSetupSlot {
  name: string
  type: string
  optional: boolean
  envPrefix: string | null
  /** `connected`: its matching attachment is ready; `env`: no attachment and `.env` fills it (every name, or any name under `envPrefix` for a slot with no `fields`); else `missing`. */
  state: 'connected' | 'env' | 'missing'
  /** The attached record the slot is judged by — ready when `connected`, otherwise the reason it does not count. */
  attached: { credential: ServiceCredentialDto; state: ServiceCredentialAttachmentState } | null
  /** `<envPrefix><FIELD>` names the slot reads from `credentials/.env`; empty when it declares no `fields`. */
  expectedKeys: string[]
  /** As `LocalAgentCredentialState.presentKeys`: for a slot with no `fields`, every set name under `envPrefix`. */
  presentKeys: string[]
  /** The active account's records that fit, best first; empty when connected. */
  options: CredentialSetupOption[]
}
/**
 * Per slot answer of Core's `POST /skills/packages/{uuid}/revisions/{n}/provision-local`.
 * `shared` / `already_shared`: the publisher's credential is now listed for this account;
 * `user_provides`: the user brings their own; `not_shareable` / `not_allowed_locally`: the
 * publisher provides it, but not for this computer.
 */
export type SkillProvisionOutcome = 'shared' | 'already_shared' | 'user_provides' | 'not_shareable' | 'not_allowed_locally'
export interface SkillProvisionSlot { slot: string; type: string; providedBy: string; outcome: SkillProvisionOutcome; credentialId: string | null }
/**
 * A credential slot the agent's skills declare (`credentials:` in a deliverable skill's SKILL.md),
 * one per `(slot, type)`. The slot is the Service URI the skill finds its credential by; only an
 * attached record of that type with exactly that Service URI fills it (strict, as Core's).
 * Never blocks the agent: a script fails at call time instead.
 */
export interface CredentialSetupSkillSlot {
  /** The Service URI the skill asks for (`by_slot` / `require_slot`). */
  slot: string
  type: string
  /** The skills that declare it, by name. */
  skills: string[]
  /** The first declaring skill's description of it, if any. */
  description: string | null
  /** `connected`: a strictly matching attachment is ready. */
  state: 'connected' | 'missing'
  /** The strictly matching attachment the slot is judged by, ready when `connected`. */
  attached: { credential: ServiceCredentialDto; state: ServiceCredentialAttachmentState } | null
  /** An attached record with this Service URI but another type: the skill's `by_slot` would find it, and it does not fit. */
  typeMismatch: ServiceCredentialDto | null
  /** The active account's records that fit strictly, best first; empty when connected. */
  options: CredentialSetupOption[]
  /** What the last `provision-local` call this app session answered for this slot, if any. */
  provision: SkillProvisionOutcome | null
}
export interface CredentialSetupDto {
  slots: CredentialSetupSlot[]
  /** The skills' slots, apart from the agent's own: they never decide `setupNeeded`. */
  skillSlots: CredentialSetupSkillSlot[]
  /** A required slot is still unsatisfied (the agent reads `credentials_needed`). */
  setupNeeded: boolean
}
/**
 * A credential attached without asking after a Get, Update or Use the team's version.
 * `skill: true` for a skill slot, whose `slot` is a Service URI and may equal an agent slot's name.
 */
export interface AutoAttachedCredential { slot: string; credentialName: string; skill?: true }
export type ServiceCredentialResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string }
