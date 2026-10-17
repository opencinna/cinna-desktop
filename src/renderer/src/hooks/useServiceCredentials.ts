import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { useFinishSetupStore } from '../stores/finishSetup.store'
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
/**
 * Remember the skill slots main filled without asking in the background (after Add to agent or
 * Update of a catalog skill), so Finish setup says "Connected automatically" however long
 * `provision-local` took. Mount once, for the app's lifetime.
 */
export function useSkillCredentialsWatch(): void {
  useEffect(() => window.api.serviceCredentials.onChanged((payload) => {
    if (payload.autoAttached) useFinishSetupStore.getState().remember(payload.autoAttached.agentId, payload.autoAttached.items)
  }), [])
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
/** Each credential slot of one agent, its state and what the active account offers for it (Finish setup). */
export function useCredentialSetup(agentId: string, enabled = true) {
  useCredentialsChanged()
  return useQuery({ queryKey: ['service-credentials', 'setup', agentId], enabled,
    queryFn: async () => credentialResult(await window.api.serviceCredentials.setupState(agentId)) })
}
export const oauthFlowKey = (agentId: string) => ['service-credential-oauth-flow', agentId] as const
/**
 * The agent's Google connect flow (New in Attach credential, or Reconnect), or null. The flow lives
 * in main and outlives the modal; main announces its changes through `onChanged`, so it is refetched then.
 */
export function useOAuthConnectFlow(agentId: string, enabled = true) {
  const queryClient = useQueryClient()
  useEffect(() => window.api.serviceCredentials.onChanged(() => {
    void queryClient.invalidateQueries({ queryKey: oauthFlowKey(agentId) })
  }), [queryClient, agentId])
  return useQuery({ queryKey: oauthFlowKey(agentId), enabled,
    queryFn: async () => credentialResult(await window.api.serviceCredentials.oauthFlow(agentId)) })
}
