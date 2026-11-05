import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { useFinishSetupStore } from '../stores/finishSetup.store'
import { skillsLackingCredentials, useSkillCredentialPromptStore } from '../stores/skillCredentialPrompt.store'
import { LOCAL_AGENTS_KEY, localAgentKey, type LocalAgentsSnapshot } from './useLocalAgents'
import type { LocalAgentDto } from '../../../shared/localAgents'
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
 * `provision-local` took; and, once that fill settles, re-read the agent and raise the composer's
 * prompt for those of the skills it named that still lack a credential, bumping the agent's settle
 * counter either way (a skill-link offer waiting on the fill goes then). Mount once, for the app's
 * lifetime.
 */
export function useSkillCredentialsWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => window.api.serviceCredentials.onChanged((payload) => {
    if (payload.autoAttached) useFinishSetupStore.getState().remember(payload.autoAttached.agentId, payload.autoAttached.items)
    const settled = payload.skillSlotsSettled
    if (!settled) return
    void (async () => {
      const { agentId, skills } = settled
      // The row reads `filled` from the agent list: decide only once it is re-read after the fill,
      // or a slot the fill just filled would be raised, and a filled skill prompted for nothing.
      await Promise.all([
        queryClient.refetchQueries({ queryKey: LOCAL_AGENTS_KEY }),
        queryClient.refetchQueries({ queryKey: localAgentKey(agentId) })
      ]).catch(() => undefined)
      let folder: LocalAgentDto | null = queryClient.getQueryData<LocalAgentsSnapshot>(LOCAL_AGENTS_KEY)?.agents.find((a) => a.id === agentId) ?? null
      if (!folder) {
        // No list cached (nothing has asked for it yet): ask for the one agent.
        const outcome = await window.api.localAgents.get(agentId).catch(() => null)
        folder = outcome?.ok ? outcome.value : null
      }
      useSkillCredentialPromptStore.getState().settle(agentId, folder ? skillsLackingCredentials(folder, skills).map(({ skill }) => skill.name) : [])
    })()
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
