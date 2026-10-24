import { useRef } from 'react'
import { keepPreviousData, useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  addonRefKey,
  type AddonActionResult,
  type AddonDirectoryResult,
  type AddonRef,
  type AddonSearchResult
} from '../../../shared/addons/directory'
import { useAuthStore } from '../stores/auth.store'
import { INBOX_QUERY_KEY } from './useInbox'
import { LOCAL_AGENTS_KEY, localAgentKey } from './useLocalAgents'
import { readCatalogItemsFromCache } from './useCatalog'
import { marketplaceSkillStatusKey } from './useMarketplaceSkills'

/**
 * The addon directory of one folder agent (`window.api.addons`): every skill
 * and MCP connector it could add, each with its state for the agent, a search
 * over the sources too large to list, and one Add / Remove. Every
 * answer is data — a refusal is `{ok: false, code, message}` with main's
 * sentence — so the caller shows it beside the control that asked.
 *
 * The re-reads after Add / Remove live at the hook level, not in a `mutate`
 * callback: they must run even when the picker that asked has gone (a
 * TanStack mutate-level callback is dropped on unmount).
 */

/** Every query of this module. */
export const ADDONS_KEY = ['addons'] as const

export function addonDirectoryKey(agentId: string, profileId: string | null): readonly unknown[] {
  return [...ADDONS_KEY, 'directory', agentId, profileId]
}

export function addonSearchKey(agentId: string, query: string, profileId: string | null): readonly unknown[] {
  return [...ADDONS_KEY, 'search', agentId, profileId, query.trim()]
}

/** One add of one entry to one agent: the picker reads it back by this key, even after it was closed and reopened. */
export function addonAddKey(agentId: string, ref: AddonRef): readonly unknown[] {
  return [...ADDONS_KEY, 'add', agentId, addonRefKey(ref)]
}

/** A refused read, thrown so the query keeps the last good answer as `data`. */
export class AddonDirectoryReadError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'AddonDirectoryReadError'
  }
}

/**
 * What an add or a remove can have moved: the directory itself, the agent's
 * skill rows and their marketplace status, the catalog's "Added to" pill, the
 * Inbox's skill cards, and the Addons tab's connector queries.
 */
export function refreshAfterAddonChange(queryClient: QueryClient, agentId: string): void {
  void queryClient.invalidateQueries({ queryKey: ADDONS_KEY })
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
  void queryClient.invalidateQueries({ queryKey: localAgentKey(agentId) })
  void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
  void queryClient.invalidateQueries({ queryKey: marketplaceSkillStatusKey(agentId) })
  void queryClient.invalidateQueries({ queryKey: ['agent-mcp', agentId] })
  void queryClient.invalidateQueries({ queryKey: ['mcp-providers'] })
  void queryClient.invalidateQueries({ queryKey: ['mcp-agents-using'] })
  void readCatalogItemsFromCache(queryClient)
}

/**
 * The merged directory for an agent; `data` keeps the last good answer when a
 * read is refused. `refreshOnMount` (the picker): the first read of this
 * mount always runs and asks main to re-read the sources' caches (the
 * catalog listing, the marketplace list); an earlier answer shows meanwhile.
 * Later reads (after an add) use the caches again.
 */
export function useAddonDirectory(agentId: string | null, options: { enabled?: boolean; refreshOnMount?: boolean } = {}) {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const refreshed = useRef(!options.refreshOnMount)
  return useQuery<Extract<AddonDirectoryResult, { ok: true }>>({
    queryKey: addonDirectoryKey(agentId ?? '', profileId),
    queryFn: async () => {
      const refresh = !refreshed.current
      refreshed.current = true
      const result = await window.api.addons.directory(agentId as string, refresh ? { refresh: true } : {})
      if (!result.ok) throw new AddonDirectoryReadError(result.code, result.message)
      return result
    },
    enabled: !!agentId && options.enabled !== false,
    staleTime: 60_000,
    refetchOnMount: options.refreshOnMount ? 'always' : true,
    refetchOnWindowFocus: false,
    retry: false
  })
}

/** Read the directory again past the sources' caches (after signing in to Cinna again), into the same query. */
export function useRefreshAddonDirectory(agentId: string): () => Promise<unknown> {
  const queryClient = useQueryClient()
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  return () =>
    queryClient.fetchQuery({
      queryKey: addonDirectoryKey(agentId, profileId),
      queryFn: async () => {
        const result = await window.api.addons.directory(agentId, { refresh: true })
        if (!result.ok) throw new AddonDirectoryReadError(result.code, result.message)
        return result
      },
      staleTime: 0
    })
}

/** The search-only sources (the official MCP registry); asked only for a non-empty query, so debounce it before passing it in. */
export function useAddonSearch(agentId: string | null, query: string) {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const trimmed = query.trim()
  return useQuery<Extract<AddonSearchResult, { ok: true }>>({
    queryKey: addonSearchKey(agentId ?? '', trimmed, profileId),
    queryFn: async () => {
      const result = await window.api.addons.search(agentId as string, trimmed)
      if (!result.ok) throw new AddonDirectoryReadError(result.code, result.message)
      return result
    },
    enabled: !!agentId && trimmed.length > 0,
    // The last answer stays (dimmed by the picker) while the next query is asked: nothing collapses per keystroke.
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false
  })
}

type ActionVariables = { agentId: string; ref: AddonRef }

/**
 * Add an entry to an agent. A refusal is the mutation's `data`, not its error.
 * `next` says which in-place step the picker shows (`oauth`, `bearer`, `env`,
 * `connect`). Each run is keyed by agent and entry ({@link addonAddKey}), so
 * {@link useAddonAdds} reads it back after the picker that asked was closed.
 */
export function useAddAddon() {
  const queryClient = useQueryClient()
  return {
    run: (variables: ActionVariables): Promise<AddonActionResult> =>
      queryClient
        .getMutationCache()
        .build<AddonActionResult, Error, ActionVariables, unknown>(queryClient, {
          mutationKey: addonAddKey(variables.agentId, variables.ref),
          mutationFn: ({ agentId, ref }) => window.api.addons.add(agentId, ref),
          onSettled: (_result, _error, { agentId }) => refreshAfterAddonChange(queryClient, agentId)
        })
        .execute(variables)
  }
}

/** One add as the picker reads it back: running, or how it ended. */
export interface AddonAddRun {
  key: string
  status: 'pending' | 'success' | 'error' | 'idle'
  result: AddonActionResult | undefined
  error: Error | null
  submittedAt: number
  /** Tells an add that had ended before this opening of the picker from one that ends in it. */
  mutationId: number
}

/**
 * Every add to this agent in the mutation cache, newest last, keyed by the
 * entry's ref key — it survives the picker closing: a reopened picker still
 * shows Adding… and the step that add ended on.
 */
export function useAddonAdds(agentId: string): Map<string, AddonAddRun> {
  const runs = useMutationState<AddonAddRun>({
    filters: { mutationKey: [...ADDONS_KEY, 'add', agentId] },
    select: (mutation) => ({
      key: String((mutation.options.mutationKey as unknown[])[3]),
      status: mutation.state.status,
      result: mutation.state.data as AddonActionResult | undefined,
      error: mutation.state.error as Error | null,
      submittedAt: mutation.state.submittedAt,
      mutationId: mutation.mutationId
    })
  })
  const latest = new Map<string, AddonAddRun>()
  for (const run of runs) {
    const known = latest.get(run.key)
    if (!known || run.submittedAt >= known.submittedAt) latest.set(run.key, run)
  }
  return latest
}

/** The adds to this agent that have already ended: read once when the picker opens. */
export function settledAddonAdds(queryClient: QueryClient, agentId: string): ReadonlySet<number> {
  return new Set(
    queryClient
      .getMutationCache()
      .findAll({ mutationKey: [...ADDONS_KEY, 'add', agentId] })
      .filter((mutation) => mutation.state.status !== 'pending')
      .map((mutation) => mutation.mutationId)
  )
}

/** Unpin a skill or detach a connector; a local connector is detached, never deleted. */
export function useRemoveAddon() {
  const queryClient = useQueryClient()
  return useMutation<AddonActionResult, Error, ActionVariables>({
    mutationFn: ({ agentId, ref }) => window.api.addons.remove(agentId, ref),
    onSettled: (_result, _error, { agentId }) => refreshAfterAddonChange(queryClient, agentId)
  })
}
