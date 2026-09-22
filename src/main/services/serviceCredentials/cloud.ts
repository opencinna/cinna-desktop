import { cinnaFetch } from '../cinna-http'
import type { ServiceCredentialBundle, ServiceCredentialEntry } from '../../../shared/serviceCredentials'
export interface CloudCredentialMetadata {
  id: string; name: string; type: string; notes: string | null; service_uri: string | null
  status: string; is_placeholder: boolean; relation: 'owned' | 'shared'; owner_email: string | null
  local_use_allowed: boolean; revision: string; expires_at?: number | null
}
export interface CloudDelivery {
  items: ServiceCredentialBundle[]; refused: { id: string; reason: string }[]
  current_user: ServiceCredentialEntry | null; owner_identity: ServiceCredentialEntry | null
}
export const serviceCredentialCloud = {
  list: (userId: string, signal?: AbortSignal) => cinnaFetch<{ items: CloudCredentialMetadata[] }>(userId, '/api/v1/external/credentials', { sensitive: true, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }),
  materialize: (userId: string, ids: string[], signal?: AbortSignal) => cinnaFetch<CloudDelivery>(userId, '/api/v1/external/credentials/materialize', {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    method: 'POST', body: { credential_ids: ids, include_current_user: true }, sensitive: true
  })
}
