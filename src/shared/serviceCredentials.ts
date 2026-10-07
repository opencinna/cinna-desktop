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
export type ServiceCredentialResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string }
