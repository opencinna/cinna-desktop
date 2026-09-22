import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import type { ServiceCredentialResult } from '../../../shared/serviceCredentials'
export function credentialResult<T>(result: ServiceCredentialResult<T>): T {
  if (!result.ok) throw new Error(result.message)
  return result.value
}
/** Refetch every credential query when main reports a change (sync, save, attach, account set). */
function useCredentialsChanged() {
  const queryClient = useQueryClient()
  useEffect(() => window.api.serviceCredentials.onChanged(() => {
    void queryClient.invalidateQueries({ queryKey: ['service-credentials'] })
  }), [queryClient])
}
export function useServiceCredentials() {
  const userId = useAuthStore(s => s.currentUser?.id)
  const serverUrl = useAuthStore(s => s.currentUser?.cinnaServerUrl ?? null)
  useCredentialsChanged()
  return useQuery({ queryKey: ['service-credentials', userId, serverUrl], enabled: !!userId,
    queryFn: async ({ signal }) => {
      const result = await window.api.serviceCredentials.list(userId!, serverUrl)
      signal.throwIfAborted()
      return credentialResult(result)
    } })
}
export function useCredentialAttachments(id: string) {
  const userId = useAuthStore(s => s.currentUser?.id)
  return useQuery({ queryKey: ['service-credentials', userId, id], queryFn: async () => credentialResult(await window.api.serviceCredentials.attachments(id)) })
}
/** The attach picker's groups: local records, then each eligible account's cache. */
export function useCredentialAttachOptions(agentId: string, enabled = true) {
  useCredentialsChanged()
  return useQuery({ queryKey: ['service-credentials', 'attach-options', agentId], enabled,
    queryFn: async () => credentialResult(await window.api.serviceCredentials.attachOptions(agentId)) })
}
