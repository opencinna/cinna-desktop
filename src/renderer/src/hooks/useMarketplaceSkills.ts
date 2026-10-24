import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  MarketplaceSkillEnsureResult,
  MarketplaceSkillOutcome,
  MarketplaceSkillStatusResult
} from '../../../shared/marketplaceSkills'
import type { LocalAgentSkill } from '../../../shared/localAgents'
import { LOCAL_AGENTS_KEY, localAgentKey } from './useLocalAgents'

/**
 * Marketplace skill pins in a kit agent (`window.api.marketplaceSkills`):
 * update, remove, fetch again, and where each pin stands. Adding one goes
 * through the addon directory (`useAddonDirectory.ts`). Every answer is data — a refusal is
 * `{ok: false, code, message}` with main's sentence — so the caller shows it
 * beside the control that asked (ux_rules rule 6).
 *
 * The re-reads live at the hook level, not in a `mutate` callback: they must
 * run even when the row that asked has gone (a TanStack
 * mutate-level callback is dropped on unmount).
 */

/** Every query of this module; each agent's status sits under it. */
export const MARKETPLACE_SKILLS_KEY = ['marketplace-skills'] as const

/** Every status read of one agent, whatever pins it was read for. */
export function marketplaceSkillStatusKey(agentId: string): readonly unknown[] {
  return [...MARKETPLACE_SKILLS_KEY, 'status', agentId]
}

/** What a pin change can have moved: the agent's rows and its pins' status. */
function refreshAfterMarketplaceChange(queryClient: QueryClient, agentId: string): void {
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
  void queryClient.invalidateQueries({ queryKey: localAgentKey(agentId) })
  void queryClient.invalidateQueries({ queryKey: marketplaceSkillStatusKey(agentId) })
}

/** The marketplace pins of an agent's skill rows. */
export function marketplacePins(skills: readonly LocalAgentSkill[] | undefined): LocalAgentSkill[] {
  return (skills ?? []).filter((skill) => skill.source === 'marketplace')
}

/**
 * Where each of an agent's marketplace pins stands (`current`,
 * `update_available`, `unavailable`), read while the Addons tab shows an agent
 * that has one. The key carries the pins as written, so a pin changed by
 * anything — a sharing update, an edit — is read again. Read again each time
 * the tab mounts for the agent and when the window regains focus, so a
 * marketplace that moved on shows Update (or unavailable) on the next visit;
 * the staleTime only spares re-renders.
 */
export function useMarketplaceSkillStatus(agentId: string, skills: readonly LocalAgentSkill[] | undefined) {
  const pins = marketplacePins(skills)
  const signature = pins.map((pin) => `${pin.name}:${pin.entryUuid ?? ''}:${pin.archiveSha256 ?? ''}`).join('|')
  return useQuery<MarketplaceSkillStatusResult>({
    queryKey: [...marketplaceSkillStatusKey(agentId), signature],
    queryFn: () => window.api.marketplaceSkills.status(agentId),
    enabled: pins.length > 0,
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: false
  })
}

export function useUpdateMarketplaceSkill() {
  const queryClient = useQueryClient()
  return useMutation<MarketplaceSkillOutcome, Error, { agentId: string; name: string }>({
    mutationFn: ({ agentId, name }) => window.api.marketplaceSkills.update(agentId, name),
    onSettled: (_result, _error, { agentId }) => refreshAfterMarketplaceChange(queryClient, agentId)
  })
}

export function useRemoveMarketplaceSkill() {
  const queryClient = useQueryClient()
  return useMutation<MarketplaceSkillOutcome, Error, { agentId: string; name: string }>({
    mutationFn: ({ agentId, name }) => window.api.marketplaceSkills.remove(agentId, name),
    onSettled: (_result, _error, { agentId }) => refreshAfterMarketplaceChange(queryClient, agentId)
  })
}

export function useEnsureMarketplaceSkills() {
  const queryClient = useQueryClient()
  return useMutation<MarketplaceSkillEnsureResult, Error, { agentId: string }>({
    mutationFn: ({ agentId }) => window.api.marketplaceSkills.ensure(agentId),
    onSettled: (_result, _error, { agentId }) => refreshAfterMarketplaceChange(queryClient, agentId)
  })
}
