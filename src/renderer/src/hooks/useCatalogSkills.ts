import { useCallback } from 'react'
import { useMutation, useMutationState, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { CatalogSkillEnsureResult, CatalogSkillOutcome } from '../../../shared/catalogSkills'
import { INBOX_QUERY_KEY } from './useInbox'
import { LOCAL_AGENTS_KEY, localAgentKey } from './useLocalAgents'
import { readCatalogItemsFromCache } from './useCatalog'
import { unwrapIpcError } from '../utils/ipcError'

/**
 * Catalog skills in a kit agent: add, update, remove and fetch again
 * (`window.api.catalogSkills`). Every answer is data — a refusal is
 * `{ok: false, code, message}` with main's sentence — so the caller shows it
 * beside the control that asked (ux_rules rule 6).
 *
 * The re-reads live at the hook level, not in a `mutate` callback: they must
 * run even when the picker or the row that asked has gone (a TanStack
 * mutate-level callback is dropped on unmount).
 */

/** What a pin change can have moved: the agent's rows, the catalog's "Added to" pill, the Inbox's skill cards. */
function refreshAfterSkillChange(queryClient: QueryClient, agentId: string): void {
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
  void queryClient.invalidateQueries({ queryKey: localAgentKey(agentId) })
  void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
  void readCatalogItemsFromCache(queryClient)
}

/** Every add of one catalog skill, whichever picker started it. */
export function addCatalogSkillKey(packageUuid: string): readonly unknown[] {
  return ['catalog-skills', 'add', packageUuid.toLowerCase()]
}

type AddVariables = { agentId: string; packageUuid: string }

/**
 * Add a catalog skill to an agent. Keyed by the package, so
 * {@link useCatalogSkillAdds} can read every add of it from the mutation
 * cache — the picker that started one may have unmounted since.
 */
export function useAddCatalogSkill(packageUuid: string) {
  const queryClient = useQueryClient()
  return useMutation<CatalogSkillOutcome, Error, AddVariables>({
    mutationKey: addCatalogSkillKey(packageUuid),
    mutationFn: ({ agentId, packageUuid: uuid }) => window.api.catalogSkills.add(agentId, uuid),
    onSettled: (_result, _error, { agentId }) => refreshAfterSkillChange(queryClient, agentId)
  })
}

/** One agent's latest add of a skill, as every picker of that skill sees it. */
export interface CatalogSkillAddState {
  agentId: string
  status: 'pending' | 'added' | 'refused'
  /** The refusal in main's words, or the fallback; null unless `refused`. */
  message: string | null
  /** When it was asked; tells one add from the next. */
  submittedAt: number
}

/**
 * The adds of one skill, per agent (latest only), read from the mutation
 * cache so a remounted picker still shows `Adding…` and the refusal that
 * landed while it was gone. `consume` drops the settled ones — a refusal
 * belongs to one opening of the menu.
 */
export function useCatalogSkillAdds(packageUuid: string, fallback: string): {
  byAgent: Map<string, CatalogSkillAddState>
  consume: () => void
} {
  const queryClient = useQueryClient()
  const key = addCatalogSkillKey(packageUuid)
  const states = useMutationState({
    filters: { mutationKey: key, exact: true },
    select: (mutation): CatalogSkillAddState | null => {
      const { status, variables, data, error, submittedAt } = mutation.state
      const agentId = (variables as AddVariables | undefined)?.agentId
      if (!agentId || status === 'idle') return null
      if (status === 'pending') return { agentId, status: 'pending', message: null, submittedAt }
      if (status === 'error') return { agentId, status: 'refused', message: unwrapIpcError(error, fallback), submittedAt }
      const outcome = data as CatalogSkillOutcome | undefined
      if (outcome && !outcome.ok) return { agentId, status: 'refused', message: catalogSkillOutcomeMessage(outcome, fallback), submittedAt }
      return { agentId, status: 'added', message: null, submittedAt }
    }
  })
  const byAgent = new Map<string, CatalogSkillAddState>()
  for (const state of states) {
    if (!state) continue
    const seen = byAgent.get(state.agentId)
    if (!seen || state.submittedAt >= seen.submittedAt) byAgent.set(state.agentId, state)
  }
  const consume = useCallback((): void => {
    const cache = queryClient.getMutationCache()
    for (const mutation of cache.findAll({ mutationKey: addCatalogSkillKey(packageUuid), exact: true })) {
      if (mutation.state.status !== 'pending') cache.remove(mutation)
    }
  }, [queryClient, packageUuid])
  return { byAgent, consume }
}

export function useUpdateCatalogSkill() {
  const queryClient = useQueryClient()
  return useMutation<CatalogSkillOutcome, Error, { agentId: string; name: string }>({
    mutationFn: ({ agentId, name }) => window.api.catalogSkills.update(agentId, name),
    onSettled: (_result, _error, { agentId }) => refreshAfterSkillChange(queryClient, agentId)
  })
}

export function useRemoveCatalogSkill() {
  const queryClient = useQueryClient()
  return useMutation<CatalogSkillOutcome, Error, { agentId: string; name: string }>({
    mutationFn: ({ agentId, name }) => window.api.catalogSkills.remove(agentId, name),
    onSettled: (_result, _error, { agentId }) => refreshAfterSkillChange(queryClient, agentId)
  })
}

export function useEnsureCatalogSkills() {
  const queryClient = useQueryClient()
  return useMutation<CatalogSkillEnsureResult, Error, { agentId: string }>({
    mutationFn: ({ agentId }) => window.api.catalogSkills.ensure(agentId),
    onSettled: (_result, _error, { agentId }) => refreshAfterSkillChange(queryClient, agentId)
  })
}

/** The sentence for a refused or failed action: main's own, else `fallback`. */
export function catalogSkillOutcomeMessage(outcome: { ok: false; message: string }, fallback: string): string {
  return outcome.message.trim() !== '' ? outcome.message : fallback
}
