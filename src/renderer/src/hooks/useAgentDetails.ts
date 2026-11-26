import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { agentDetailsTargetKey, type AgentDetailsResult, type AgentDetailsTarget } from '../../../shared/agentDetails'

/** Every Details query; the profile and the target follow. */
export const AGENT_DETAILS_KEY = ['agent-details'] as const

export function agentDetailsKey(profileId: string | null, target: AgentDetailsTarget | null) {
  return [...AGENT_DETAILS_KEY, profileId, target ? agentDetailsTargetKey(target) : null] as const
}

/**
 * An agent's Details as main reads them, for the active profile. Read again
 * whenever a surface showing it mounts: core's ETag answers that with a 304,
 * and a folder agent's file is cheap to read. Failures are data
 * (`unsupported`, `not_found`, `unavailable`), so the query itself only fails
 * when the IPC call does.
 */
export function useAgentDetails(target: AgentDetailsTarget | null) {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  return useQuery<AgentDetailsResult>({
    queryKey: agentDetailsKey(profileId, target),
    queryFn: () => window.api.agentDetails.get(target as AgentDetailsTarget),
    enabled: profileId !== null && target !== null,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: false
  })
}
