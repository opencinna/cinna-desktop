import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import type { ServiceCredentialResult } from '../../../shared/serviceCredentials'
export function credentialResult<T>(result: ServiceCredentialResult<T>): T {
  if (!result.ok) throw new Error(result.message)
  return result.value
}
export function useServiceCredentials() {
  const userId = useAuthStore(s => s.currentUser?.id)
  const serverUrl = useAuthStore(s => s.currentUser?.cinnaServerUrl ?? null)
  const queryClient = useQueryClient()
  useEffect(() => window.api.serviceCredentials.onChanged(() => {
    void queryClient.invalidateQueries({ queryKey: ['service-credentials'] })
  }), [queryClient])
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
