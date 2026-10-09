import { useEffect } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult
} from '@tanstack/react-query'
import type {
  AgentRemoteKind,
  AgentShareResult,
  AgentShareStatus,
  LibraryListingDto,
  ShareWithTeamDraft
} from '../../../shared/agentSharing'
import { unwrapCatalogOutcome } from '../../../shared/catalog'
import { useAuthStore } from '../stores/auth.store'
import { isReauthRequiredError } from '../stores/reauth.store'
import { INBOX_QUERY_KEY } from './useInbox'
import { LOCAL_AGENTS_KEY, LOCAL_AGENT_ROOTS_KEY, localAgentKey } from './useLocalAgents'

/**
 * Team sharing of folder agents, as the renderer reads and drives it.
 *
 * Main owns every bit of state — whether a folder is shared, where its team
 * version lives, what the library lists — and pushes `sharing:changed` when
 * any of it moves; {@link useSharingWatch} turns that into one invalidation of
 * everything under {@link SHARING_KEY}. Every IPC resolves with a
 * `SharingOutcome`, unwrapped with the catalog's helper (same shape): an
 * expected refusal travels in the value as a code, and only what no surface
 * can show as a state is thrown — `reauth_required` among them, which the
 * query and mutation caches turn into the app-wide prompt.
 */

export const SHARING_KEY = ['sharing'] as const

/**
 * Keyed by profile under the brief's `['sharing','statuses']` prefix: which
 * state a Cinna remote is in (`other_account`, the caller's access) depends on
 * who is signed in, and a list read under one account is not the next one's.
 */
export function sharingStatusesKey(profileId: string | null): readonly unknown[] {
  return ['sharing', 'statuses', profileId] as const
}

/**
 * Keyed by profile too, for the same reason as the list: the state and the
 * caller's access read differently under another account, and a page left
 * open across a profile switch must not keep the last account's answer.
 */
export function sharingStatusKey(profileId: string | null, agentId: string): readonly unknown[] {
  return ['sharing', 'status', profileId, agentId] as const
}

/** Same reason as {@link sharingStatusesKey}: the library is the active profile's. */
export function sharingLibraryKey(profileId: string | null): readonly unknown[] {
  return ['sharing', 'library', profileId] as const
}

/** `useAgents`' key; a Get or an Update can add or rename a folder agent row. */
const AGENTS_KEY = ['agents'] as const

/** How often an `external` agent's page may reach the network for its counts. */
const EXTERNAL_FETCH_INTERVAL_MS = 60_000

/**
 * When each external agent last fetched, outside the query cache on purpose.
 *
 * A fetch moves the counts, main pushes `sharing:changed`, and the watch
 * invalidates the status — which would refetch, with a fetch, and push again.
 * Deciding `fetch` from the clock rather than from "this is a refetch" bounds
 * the network to once a minute per agent whatever triggered the read.
 */
const lastExternalFetch = new Map<string, number>()

/** Test seam: forget the per-agent fetch clock. */
export function resetSharingFetchClock(): void {
  lastExternalFetch.clear()
}

function useProfileId(): string | null {
  return useAuthStore((s) => s.currentUser?.id ?? null)
}

/** Every shared agent on this machine, without reaching the network. The sidebar's read. */
export function useShareStatuses(): UseQueryResult<AgentShareStatus[]> {
  const profileId = useProfileId()
  return useQuery<AgentShareStatus[]>({
    queryKey: sharingStatusesKey(profileId),
    queryFn: async () => unwrapCatalogOutcome(await window.api.sharing.statuses()),
    staleTime: 30_000
  })
}

/**
 * This agent's entry in the statuses list: `undefined` while the list loads,
 * `null` when the agent is not shared. What decides whether a surface reserves
 * a sharing slot at all, before the agent's own status lands.
 */
export function useListedShareStatus(agentId: string | null): AgentShareStatus | null | undefined {
  const { data } = useShareStatuses()
  if (data === undefined) return undefined
  if (agentId === null) return null
  return data.find((entry) => entry.agentId === agentId) ?? null
}

/**
 * One agent's status, for its page. An `external` agent fetches on mount at
 * most once a minute (see {@link lastExternalFetch}); a `cinna` one never
 * does — its counts come from the library listing main already holds.
 */
export function useShareStatus(
  agentId: string | null,
  remoteKind: AgentRemoteKind | null
): UseQueryResult<AgentShareStatus | null> {
  const profileId = useProfileId()
  return useQuery<AgentShareStatus | null>({
    queryKey: sharingStatusKey(profileId, agentId ?? ''),
    queryFn: async () => {
      const id = agentId as string
      const now = Date.now()
      const fetch =
        remoteKind === 'external' &&
        now - (lastExternalFetch.get(id) ?? 0) >= EXTERNAL_FETCH_INTERVAL_MS
      if (fetch) lastExternalFetch.set(id, now)
      return unwrapCatalogOutcome(await window.api.sharing.status(id, fetch))
    },
    enabled: agentId !== null && remoteKind !== null,
    staleTime: EXTERNAL_FETCH_INTERVAL_MS
  })
}

/**
 * The active profile's Team library; null for a profile that is not a Cinna
 * one. `refresh` is the catalog opening: main re-reads the listing then.
 */
export function useTeamLibrary(options: { refresh?: boolean } = {}): UseQueryResult<LibraryListingDto | null> {
  const profileId = useProfileId()
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const refresh = options.refresh === true
  return useQuery<LibraryListingDto | null>({
    queryKey: sharingLibraryKey(profileId),
    queryFn: async () => unwrapCatalogOutcome(await window.api.sharing.library(refresh)),
    enabled: isCinnaUser,
    staleTime: 5 * 60_000,
    // Opening the catalog is the moment the user wants the list as it is now.
    refetchOnMount: refresh ? 'always' : true,
    retry: (failures, err) => !isReauthRequiredError(err) && failures < 2
  })
}

/**
 * Subscribe to main's `sharing:changed` for the app's lifetime. Mount once,
 * beside `useLocalAgentWatch`.
 */
export function useSharingWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    return window.api.sharing.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: SHARING_KEY })
      // The Inbox's "The team changed X" cards are derived from the same
      // listing, on every read.
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
    })
  }, [queryClient])
}

/**
 * Write what an action returned into the caches. Each result carries the
 * status after it, so the line updates without a second read; the list and
 * the library are re-read, since a sidebar dot or a tile may have changed.
 */
function applyResult(queryClient: QueryClient, agentId: string, result: AgentShareResult): void {
  // Read at settle time, outside React: the hooks' callbacks run after an
  // unmount too. A result that lands after a profile switch is written under
  // the account now active, which is the one main answered for.
  const profileId = useAuthStore.getState().currentUser?.id ?? null
  if (result.status) queryClient.setQueryData(sharingStatusKey(profileId, result.status.agentId), result.status)
  else void queryClient.invalidateQueries({ queryKey: sharingStatusKey(profileId, agentId) })
  void queryClient.invalidateQueries({ queryKey: ['sharing', 'statuses'] })
  void queryClient.invalidateQueries({ queryKey: ['sharing', 'library'] })
  void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
}

/** After an action that rewrote a folder: everything the rescan can have moved. */
function invalidateRescanned(queryClient: QueryClient, agentIds: (string | null)[]): void {
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENT_ROOTS_KEY })
  void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })
  for (const id of agentIds) {
    if (!id) continue
    void queryClient.invalidateQueries({ queryKey: localAgentKey(id) })
    void queryClient.invalidateQueries({ queryKey: ['local-agent-doc', id] })
  }
}

/**
 * Hook-level callbacks, which run whether or not the component that called
 * `mutate` is still mounted (a mutate-level one is dropped on unmount). The
 * place to close a dialog or open the next one.
 */
export interface ShareMutationOptions<V> {
  onResult?: (result: AgentShareResult, variables: V) => void
}

/** Record everything unshared under a message and send it to the team. */
export function useShareChanges(options: ShareMutationOptions<{ agentId: string; message: string }> = {}) {
  const queryClient = useQueryClient()
  return useMutation<AgentShareResult, Error, { agentId: string; message: string }>({
    mutationFn: async ({ agentId, message }) =>
      unwrapCatalogOutcome(await window.api.sharing.shareChanges(agentId, message)),
    onSuccess: (result, variables) => {
      applyResult(queryClient, variables.agentId, result)
      // Sharing can bring the team's version in first (a clean combine), which
      // rewrites the folder.
      if (result.done) invalidateRescanned(queryClient, [variables.agentId])
      options.onResult?.(result, variables)
    }
  })
}

/** Bring in the team's changes when they apply cleanly. */
export function useUpdateShared(options: ShareMutationOptions<string> = {}) {
  const queryClient = useQueryClient()
  return useMutation<AgentShareResult, Error, string>({
    mutationFn: async (agentId) => unwrapCatalogOutcome(await window.api.sharing.update(agentId)),
    onSuccess: (result, agentId) => {
      applyResult(queryClient, agentId, result)
      if (result.done) invalidateRescanned(queryClient, [agentId])
      options.onResult?.(result, agentId)
    }
  })
}

/** The conflict's first button: this folder takes the team's version, the old one becomes a copy. */
export function useUseTeamVersion(options: ShareMutationOptions<string> = {}) {
  const queryClient = useQueryClient()
  return useMutation<AgentShareResult, Error, string>({
    mutationFn: async (agentId) =>
      unwrapCatalogOutcome(await window.api.sharing.useTeamVersion(agentId)),
    onSuccess: (result, agentId) => {
      applyResult(queryClient, agentId, result)
      if (result.done) invalidateRescanned(queryClient, [agentId, result.agentId])
      options.onResult?.(result, agentId)
    }
  })
}

/** Put a not-yet-shared agent in the active profile's Team library. */
export function useShareWithTeam(
  options: ShareMutationOptions<{ agentId: string; input: ShareWithTeamDraft }> = {}
) {
  const queryClient = useQueryClient()
  return useMutation<AgentShareResult, Error, { agentId: string; input: ShareWithTeamDraft }>({
    mutationFn: async ({ agentId, input }) =>
      unwrapCatalogOutcome(await window.api.sharing.shareWithTeam(agentId, input)),
    onSuccess: (result, variables) => {
      applyResult(queryClient, variables.agentId, result)
      if (result.done) invalidateRescanned(queryClient, [variables.agentId])
      options.onResult?.(result, variables)
    }
  })
}

/** Get a library agent into `Local/<slug>/`. */
export function useGetFromLibrary(options: ShareMutationOptions<string> = {}) {
  const queryClient = useQueryClient()
  return useMutation<AgentShareResult, Error, string>({
    mutationFn: async (repoId) => unwrapCatalogOutcome(await window.api.sharing.get(repoId)),
    onSuccess: (result, repoId) => {
      void queryClient.invalidateQueries({ queryKey: SHARING_KEY })
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      if (result.done) invalidateRescanned(queryClient, [result.agentId])
      options.onResult?.(result, repoId)
    }
  })
}
