import { cinnaFetch, cinnaSend } from '../cinna-http'
import type { ServiceCredentialBundle, ServiceCredentialEntry } from '../../../shared/serviceCredentials'
/** Non-secret facts Core sends with an issued Agent API key. Every field is optional; producer fields are null once it is removed, issuer_email once the issuer is. */
export interface CloudAgentApiKeyFacts {
  producer_agent_id?: string | null; producer_name?: string | null; issuer_email?: string | null
  base_url?: string | null; spec_url?: string | null; expires_at?: number | string | null
}
export interface CloudCredentialMetadata {
  id: string; name: string; type: string; notes: string | null; service_uri: string | null
  status: string; is_placeholder: boolean; relation: 'owned' | 'shared'; owner_email: string | null
  local_use_allowed: boolean; revision: string
  /** Epoch seconds, or an ISO-8601 UTC string for issued keys. */
  expires_at?: number | string | null
  /** Issued Agent API key status (`type: "agent_api"` only); null or absent for every other type. */
  key_status?: string | null
  agent_api?: CloudAgentApiKeyFacts | null
  /** Google OAuth types only: `pending_authorization` | `ready` | `reauth_required`; null otherwise. */
  oauth_status?: string | null
  /** Google OAuth types only: the Google account it was authorized for; null before consent. */
  granted_user_email?: string | null
}
export interface CloudDelivery {
  items: ServiceCredentialBundle[]; refused: { id: string; reason: string; key_status?: string | null }[]
  current_user: ServiceCredentialEntry | null
  /** Always null and ignored: an issued Agent API key carries its identity in the key itself. Kept so the response still types. */
  owner_identity: ServiceCredentialEntry | null
}
/** Core's answer to `provision-local`, as sent; validated by the caller. */
export interface CloudSkillProvision {
  slots: { slot: string; type: string; provided_by: string; outcome: string; credential_id: string | null }[]
}
/** Bounded like the other calls; `signal` (an account's or the app's) still aborts it first. */
const within = (ms: number, signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
export const serviceCredentialCloud = {
  /**
   * Ask Core to share a catalog skill revision's publisher-provided credentials with this account
   * for a local install (U11, C5). Idempotent, no credential data; a share then appears in `list`.
   */
  provisionLocal: (userId: string, packageUuid: string, revisionNumber: number, signal?: AbortSignal) => cinnaFetch<CloudSkillProvision>(userId,
    `/api/v1/skills/packages/${encodeURIComponent(packageUuid)}/revisions/${revisionNumber}/provision-local`, {
      method: 'POST', sensitive: true, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
    }),
  /** `include=agent_api_keys` opts in to issued keys on both calls (without it Core refuses them as unsupported_type); a Core that predates them ignores it. */
  list: (userId: string, signal?: AbortSignal) => cinnaFetch<{ items: CloudCredentialMetadata[] }>(userId, '/api/v1/external/credentials?include=agent_api_keys', { sensitive: true, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }),
  materialize: (userId: string, ids: string[], signal?: AbortSignal) => cinnaFetch<CloudDelivery>(userId, '/api/v1/external/credentials/materialize?include=agent_api_keys', {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    method: 'POST', body: { credential_ids: ids, include_current_user: true }, sensitive: true
  }),
  /**
   * Google OAuth, Core-brokered. Each answers `{status, ok, body}` so Core's coded refusals
   * (`{detail: {code, message}}`) come back as data. Create sends no name: Core names the record
   * by its type ("Gmail (read-only)") and reuses the caller's newest pending one of that type.
   */
  createOAuth: (userId: string, type: string, signal?: AbortSignal) => cinnaSend(userId, '/api/v1/external/credentials/oauth', { method: 'POST', json: { type }, signal: within(30_000, signal) }),
  authorizeOAuth: (userId: string, id: string, signal?: AbortSignal) => cinnaSend(userId, `/api/v1/external/credentials/${encodeURIComponent(id)}/oauth/authorize`, { method: 'POST', signal: within(30_000, signal) }),
  accessToken: (userId: string, id: string, body: { min_ttl: number; known_expires_at: number | null }, signal?: AbortSignal) =>
    cinnaSend(userId, `/api/v1/external/credentials/${encodeURIComponent(id)}/access-token`, { method: 'POST', json: body, signal: within(25_000, signal) })
}
