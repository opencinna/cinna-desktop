import { useCallback } from 'react'
import { useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  MarketplaceSkillDiscoverResult,
  MarketplaceSkillEnsureResult,
  MarketplaceSkillEntry,
  MarketplaceSkillOutcome,
  MarketplaceSkillRefusal,
  MarketplaceSkillStatusResult
} from '../../../shared/marketplaceSkills'
import type { LocalAgentSkill } from '../../../shared/localAgents'
import { useAuthStore } from '../stores/auth.store'
import { LOCAL_AGENTS_KEY, localAgentKey } from './useLocalAgents'
import { unwrapIpcError } from '../utils/ipcError'
import { catalogSkillOutcomeMessage } from './useCatalogSkills'

/**
 * Marketplace skills in a kit agent (`window.api.marketplaceSkills`): the
 * skills the connected marketplaces offer, add, update, remove, fetch again,
 * and where each pin stands. Every answer is data — a refusal is
 * `{ok: false, code, message}` with main's sentence — so the caller shows it
 * beside the control that asked (ux_rules rule 6).
 *
 * The re-reads live at the hook level, not in a `mutate` callback: they must
 * run even when the modal or the row that asked has gone (a TanStack
 * mutate-level callback is dropped on unmount).
 */

/** Every query of this module; the discover list and each agent's status sit under it. */
export const MARKETPLACE_SKILLS_KEY = ['marketplace-skills'] as const

/** The skills the marketplaces offer, as the active profile sees them. */
export function marketplaceSkillsDiscoverKey(profileId: string | null): readonly unknown[] {
  return [...MARKETPLACE_SKILLS_KEY, 'discover', profileId]
}

/** Every status read of one agent, whatever pins it was read for. */
export function marketplaceSkillStatusKey(agentId: string): readonly unknown[] {
  return [...MARKETPLACE_SKILLS_KEY, 'status', agentId]
}

/** Every add of one marketplace entry, whichever opening of the modal started it. */
export function addMarketplaceSkillKey(entryUuid: string): readonly unknown[] {
  return [...MARKETPLACE_SKILLS_KEY, 'add', entryUuid.toLowerCase()]
}

/** What a pin change can have moved: the agent's rows and its pins' status. */
function refreshAfterMarketplaceChange(queryClient: QueryClient, agentId: string): void {
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
  void queryClient.invalidateQueries({ queryKey: localAgentKey(agentId) })
  void queryClient.invalidateQueries({ queryKey: marketplaceSkillStatusKey(agentId) })
}

/**
 * A refused read of the marketplace list, thrown so the query keeps the last
 * good list on screen (a failed refresh is reported beside it, as the
 * catalog's is) — `code` is main's refusal, `message` its sentence.
 */
export class MarketplaceSkillsReadError extends Error {
  constructor(
    readonly code: MarketplaceSkillRefusal,
    message: string
  ) {
    super(message)
    this.name = 'MarketplaceSkillsReadError'
  }
}

/**
 * Every skill entry the marketplaces offer this person, read whole so the
 * modal filters locally — no request per keystroke. Fetched while `enabled`
 * (the Marketplaces source is open); the modal asks for a fresh read once per
 * opening with `refetch`. A refusal is the query's error (a
 * {@link MarketplaceSkillsReadError}), so the entries an earlier read
 * brought stay as `data`.
 */
export function useMarketplaceSkillEntries(enabled: boolean) {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  return useQuery<MarketplaceSkillEntry[]>({
    queryKey: marketplaceSkillsDiscoverKey(profileId),
    queryFn: async () => {
      const result: MarketplaceSkillDiscoverResult = await window.api.marketplaceSkills.discover()
      if (!result.ok) throw new MarketplaceSkillsReadError(result.code, result.message)
      return result.entries
    },
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false
  })
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

type AddVariables = { agentId: string; entryUuid: string }

/** Add a marketplace skill to an agent. Keyed by the entry, so {@link useMarketplaceSkillAdds} reads it after the modal closed. */
export function useAddMarketplaceSkill(entryUuid: string) {
  const queryClient = useQueryClient()
  return useMutation<MarketplaceSkillOutcome, Error, AddVariables>({
    mutationKey: addMarketplaceSkillKey(entryUuid),
    mutationFn: ({ agentId, entryUuid: uuid }) => window.api.marketplaceSkills.add(agentId, uuid),
    onSettled: (_result, _error, { agentId }) => refreshAfterMarketplaceChange(queryClient, agentId)
  })
}

/** One agent's latest add of an entry. */
export interface MarketplaceSkillAddState {
  agentId: string
  status: 'pending' | 'added' | 'refused'
  /** The refusal in main's words, or the fallback; null unless `refused`. */
  message: string | null
  submittedAt: number
  /** The mutation's id: tells an add settled before this opening of the modal from one made in it. */
  mutationId: number
}

/**
 * The adds of one entry, per agent (latest only), read from the mutation
 * cache so a reopened modal still shows `Adding…` and the refusal that landed
 * while it was closed. `consume` drops the settled ones.
 */
export function useMarketplaceSkillAdds(entryUuid: string, fallback: string): {
  byAgent: Map<string, MarketplaceSkillAddState>
  consume: () => void
} {
  const queryClient = useQueryClient()
  const states = useMutationState({
    filters: { mutationKey: addMarketplaceSkillKey(entryUuid), exact: true },
    select: (mutation): MarketplaceSkillAddState | null => {
      const { status, variables, data, error, submittedAt } = mutation.state
      const { mutationId } = mutation
      const agentId = (variables as AddVariables | undefined)?.agentId
      if (!agentId || status === 'idle') return null
      if (status === 'pending') return { agentId, status: 'pending', message: null, submittedAt, mutationId }
      if (status === 'error') return { agentId, status: 'refused', message: unwrapIpcError(error, fallback), submittedAt, mutationId }
      const outcome = data as MarketplaceSkillOutcome | undefined
      if (outcome && !outcome.ok) return { agentId, status: 'refused', message: catalogSkillOutcomeMessage(outcome, fallback), submittedAt, mutationId }
      return { agentId, status: 'added', message: null, submittedAt, mutationId }
    }
  })
  const byAgent = new Map<string, MarketplaceSkillAddState>()
  for (const state of states) {
    if (!state) continue
    const seen = byAgent.get(state.agentId)
    if (!seen || state.submittedAt >= seen.submittedAt) byAgent.set(state.agentId, state)
  }
  const consume = useCallback((): void => {
    const cache = queryClient.getMutationCache()
    for (const mutation of cache.findAll({ mutationKey: addMarketplaceSkillKey(entryUuid), exact: true })) {
      if (mutation.state.status !== 'pending') cache.remove(mutation)
    }
  }, [queryClient, entryUuid])
  return { byAgent, consume }
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
