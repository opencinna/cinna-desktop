import type { ServiceCredentialAttachmentState, ServiceCredentialDto } from '../../../../shared/serviceCredentials'

/**
 * What the service-credential rows say about a record, as pure functions so the
 * three lists (local settings, remote settings, an agent's attachments) share one
 * vocabulary. The row renders these; it decides nothing itself. A settings row
 * describes the record; an attachment row carries main's delivery state, which
 * also knows the shared-credential refresh window the record DTO does not.
 */

export type CredentialTone = 'ok' | 'warning' | 'error'
export interface CredentialHealth { tone: CredentialTone; label: string }

const attachmentHealth: Record<ServiceCredentialAttachmentState, CredentialHealth> = {
  ready: { tone: 'ok', label: 'Ready' },
  incomplete: { tone: 'warning', label: 'Some values are missing' },
  expired: { tone: 'warning', label: 'Values expired' },
  not_cached: { tone: 'warning', label: 'Values not downloaded yet' },
  missing: { tone: 'error', label: 'This credential no longer exists' },
  local_use_not_allowed: { tone: 'error', label: 'The owner must allow use on your computer' },
  account_unavailable: { tone: 'error', label: 'Account not signed in' },
  // The detail comes from the record's key status; this stands in when it is unknown.
  key_unavailable: { tone: 'error', label: 'Unavailable — open it on the remote for details' }
}

type KeyFacts = Pick<ServiceCredentialDto, 'keyStatus' | 'agentApi'> & Partial<Pick<ServiceCredentialDto, 'keyBlocked'>>

/** Desktop refused to store the key's delivery: Core reports it active, but no agent can use it. */
const keyBlockedHealth: CredentialHealth = { tone: 'error', label: 'Blocked — this key’s API address isn’t secure (https); ask your Cinna server’s admin to fix it' }

/**
 * An issued Agent API key's status in plain words, with what to do next. The
 * producer and issuer are named when Core sent them; otherwise the wording is
 * generic. A status this build does not know reads as unavailable (fail closed).
 * A delivery Desktop blocked outranks an active or unknown status, never a dead key's.
 */
export function agentApiKeyHealth(dto: KeyFacts | null | undefined): CredentialHealth {
  const producer = dto?.agentApi?.producerName || null, issuer = dto?.agentApi?.issuerEmail || null
  switch (dto?.keyStatus) {
    case 'active': return dto.keyBlocked ? keyBlockedHealth : attachmentHealth.ready
    case 'api_disabled': return { tone: 'warning', label: producer ? `${producer}’s API is turned off — works again when its owner turns it back on` : 'API turned off by producer — works again when its owner turns it back on' }
    case 'external_access_paused': return { tone: 'warning', label: producer ? `External access to ${producer} is paused — works again when its owner resumes it` : 'External access paused — works again when its owner resumes it' }
    case 'expired': return { tone: 'error', label: issuer ? `Expired — ask ${issuer} for a new key` : 'Expired — ask the issuer for a new key' }
    case 'revoked_by_issuer': return { tone: 'error', label: issuer ? `Revoked by ${issuer} — ask them for a new key` : 'Revoked by issuer — ask the issuer for a new key' }
    case 'producer_removed': return { tone: 'error', label: producer ? `${producer} was removed — this key no longer calls anything` : 'Producer removed — the agent this key called no longer exists' }
    case 'issuer_removed': return { tone: 'error', label: 'Issuer account removed — ask the producer’s owner for a new key' }
    default: return dto?.keyBlocked ? keyBlockedHealth : attachmentHealth.key_unavailable
  }
}

/**
 * The row's status. An attachment state, when given, is authoritative (main has
 * already resolved it); otherwise it is derived from the record itself, most
 * blocking condition first.
 */
export function credentialHealth(dto: ServiceCredentialDto | null, attachmentState?: ServiceCredentialAttachmentState, now = Date.now()): CredentialHealth {
  if (attachmentState === 'key_unavailable') return dto?.keyStatus === 'active' && !dto.keyBlocked ? attachmentHealth.key_unavailable : agentApiKeyHealth(dto)
  if (attachmentState) return attachmentHealth[attachmentState]
  if (!dto) return attachmentHealth.missing
  // An issued key's own status says more than anything below it.
  if ((dto.keyStatus != null && dto.keyStatus !== 'active') || dto.keyBlocked) return agentApiKeyHealth(dto)
  if (!dto.localUseAllowed) return attachmentHealth.local_use_not_allowed
  if (dto.isPlaceholder || dto.status !== 'complete') return attachmentHealth.incomplete
  if (dto.expiresAt !== null && dto.expiresAt <= now) return attachmentHealth.expired
  // Values are downloaded only for attached records, so a remote record without
  // them is usable, not broken: it is fetched when an agent first needs it.
  if (!dto.hasValues) return { tone: 'ok', label: 'Available — values download when an agent uses it' }
  return attachmentHealth.ready
}

export type CredentialOwnershipKind = 'owned' | 'shared' | 'local'
export interface CredentialOwnership { kind: CredentialOwnershipKind; label: string }

export function credentialOwnership(dto: Pick<ServiceCredentialDto, 'origin' | 'relation' | 'ownerEmail'> & Partial<Pick<ServiceCredentialDto, 'type' | 'agentApi'>>): CredentialOwnership {
  if (dto.origin === 'local') return { kind: 'local', label: 'Stored on this computer' }
  // An issued key is owned by its recipient but was given by someone: say who.
  if (dto.type === 'agent_api') return { kind: 'owned', label: dto.agentApi?.issuerEmail ? `Issued to you by ${dto.agentApi.issuerEmail}` : 'Issued to you' }
  return dto.relation === 'shared'
    ? { kind: 'shared', label: `Shared by ${dto.ownerEmail ?? 'owner'}` }
    : { kind: 'owned', label: 'Owned by you' }
}

/** Core's page for one credential, or null when either half is unknown or the server URL is unusable. */
export function credentialManageUrl(cloudId: string | null | undefined, serverUrl: string | null | undefined): string | null {
  if (!cloudId || !serverUrl) return null
  // Suffix-joined like the catalog's link, so a Core served under a path prefix keeps it.
  try { new URL(serverUrl) } catch { return null }
  return serverUrl.replace(/\/+$/, '') + '/credential/' + encodeURIComponent(cloudId)
}

export interface AccountReference { name: string; email: string | null; serverUrl: string; host: string }

/**
 * An account in its standard on-screen form, "Name <email> host". The email is
 * dropped when it would repeat the name; the host is shown as stored when the
 * URL does not parse.
 */
export function accountReference(account: { name: string; email: string | null; serverUrl: string }): AccountReference {
  let host = account.serverUrl
  try { host = new URL(account.serverUrl).host || host } catch { /* shown as stored */ }
  return { name: account.name, email: account.email && account.email !== account.name ? account.email : null, serverUrl: account.serverUrl, host }
}

/** The signed-in profile as an {@link accountReference}; null without a server. */
export function profileReference(user: { username: string; displayName: string; cinnaFullName?: string; cinnaServerUrl?: string }): AccountReference | null {
  if (!user.cinnaServerUrl) return null
  return accountReference({ name: user.cinnaFullName?.trim() || user.displayName, email: user.username || null, serverUrl: user.cinnaServerUrl })
}
