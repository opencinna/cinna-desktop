/** Service values are write-only. Renderer reads metadata and attachment state. */
export const SERVICE_CREDENTIALS_CHANGED = 'service-credentials:changed'
export const LOCAL_CREDENTIAL_TYPES = ['api_token', 'email_imap', 'email_smtp', 'odoo', 'google_service_account'] as const
export type LocalCredentialType = typeof LOCAL_CREDENTIAL_TYPES[number]
export interface ServiceCredentialDto {
  id: string; origin: 'local' | 'cloud'; cloudId: string | null
  name: string; type: string; serviceUri: string | null; notes: string | null
  status: string; isPlaceholder: boolean; relation: 'owned' | 'shared'
  ownerEmail: string | null; localUseAllowed: boolean; revision: string | null
  hasValues: boolean; expiresAt: number | null
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
  state: 'ready' | 'missing' | 'incomplete' | 'local_use_not_allowed' | 'not_cached' | 'expired' | 'account_unavailable'
}
/** One attach-picker section: local records, or one eligible account's cache. */
export interface ServiceCredentialAttachGroup {
  key: string; label: string; detail: string; error: string | null
  items: (ServiceCredentialDto & { attached: boolean })[]
}
export interface ServiceCredentialAttachOptions { groups: ServiceCredentialAttachGroup[] }
export interface ServiceCredentialEntry {
  id: string; name: string; type: string; notes: string | null; service_uri: string | null
  is_placeholder: boolean; credential_data: Record<string, unknown>
}
export interface ServiceCredentialBundle {
  id: string; revision: string; entry: ServiceCredentialEntry
  service_account_file: Record<string, unknown> | null; ssh_key: null
}
export type ServiceCredentialResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string }
