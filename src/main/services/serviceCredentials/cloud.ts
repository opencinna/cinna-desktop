import { cinnaFetch } from '../cinna-http'
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
  })
}
