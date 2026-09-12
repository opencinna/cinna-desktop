import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { StatusRefreshIntent } from '../../../shared/agentStatus'
import { useAuthStore } from '../stores/auth.store'

type ListResult = Awaited<ReturnType<typeof window.api.agentStatus.list>>
export type AgentStatusSnapshot = NonNullable<ListResult['items']>[number]

const AGENT_STATUS_KEY = ['agent-status'] as const

/**
 * What the batch query actually caches. `items` is what every consumer reads;
 * `remoteError` is a **partial** failure — the Cinna leg failed and folder
 * agents answered from local disk anyway — which the hook re-raises through the
 * same `error` it returns for a total failure, so nothing about it is silent.
 */
interface AgentStatusCache {
  items: AgentStatusSnapshot[]
  remoteError: { code: string; message: string } | null
}

/**
 * Error thrown from the queryFn/mutationFn when the IPC handler returns
 * `{ success: false }`. Carries the typed `code` (`reauth_required`,
 * `forbidden`, `remote_unreachable`, `not_found`, `unknown`) so consumers can
 * branch on it — the plain `Error` thrown previously lost this info.
 */
export class AgentStatusRequestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentStatusRequestError'
    this.code = code
  }
}

/**
 * Polls the batch agent-status endpoint at a cadence safe for the cache-only
 * route (spec recommends 30–60 s).
 *
 * **Runs for every account.** It was gated on `currentUser?.type ===
 * 'cinna_user'`, with `refetchInterval` off entirely when disabled, because a
 * local user had no agents that could report a status. A folder agent has one,
 * and a purely local user — no Cinna account at all — is the case Local Agents
 * exists for. With that gate in place no amount of correctness in the main
 * process could reach the screen: the IPC call was never issued, so the overlay,
 * the sidebar-footer dot and the menu-bar tray (which reads this same hook
 * through `useTrayIcon` and `TrayPanel`) all stayed empty.
 *
 * The account-type condition is dropped rather than widened to "cinna user OR
 * has a folder agent". The answer to "does this user have anything to report"
 * lives in the main process, which now checks both; asking the renderer to
 * predict it means a second, independently-wrong copy of the rule, and the cost
 * of being wrong the cheap way is one IPC round trip returning `[]`, with no
 * network call behind it for a local-only account.
 */
/**
 * Whatever went wrong, as the typed error every consumer branches on — with a
 * **catch-all for a rejection that is not one of ours**.
 *
 * The last branch is the load-bearing one. It used to be `null`, so an
 * `ipcRenderer.invoke` that *rejected* — a plain `Error`, because IPC discards
 * a thrown code at two boundaries — matched neither check and left the hook
 * reporting `error: null` with `data: []` and `isLoading: false`. The overlay
 * and the tray both read that as "nothing to report" and printed "No agents
 * have reported status yet.", so a failure the user needed to act on arrived as
 * a clean panel. That is the worst shape a status surface has.
 *
 * The main-process handler now returns its code as data instead of throwing, so
 * this branch should be unreachable for the case that produced it. It stays
 * anyway, and belt-and-braces is the point: **this is the half that holds when
 * a future handler forgets the rule.** One of them is a fix; the pair is a
 * guarantee that an unexpected rejection can never again render as health.
 *
 * The message is passed through raw, IPC plumbing prefix and all. It is ugly and
 * it is supposed to be: an unexpected rejection reaching a user is a bug, and a
 * tidied message is a bug that looks handled.
 */
function toRequestError(
  queryError: unknown,
  partial: { code: string; message: string } | null
): AgentStatusRequestError | null {
  if (queryError instanceof AgentStatusRequestError) return queryError
  if (queryError) {
    return new AgentStatusRequestError(
      'unknown',
      queryError instanceof Error ? queryError.message : String(queryError)
    )
  }
  if (partial) return new AgentStatusRequestError(partial.code, partial.message)
  return null
}

export function useAgentStatus(): {
  data: AgentStatusSnapshot[]
  isLoading: boolean
  error: AgentStatusRequestError | null
  /** Resolves `true` when the refetch succeeded, `false` on any error. */
  refetch: () => Promise<boolean>
} {
  const query = useQuery({
    queryKey: AGENT_STATUS_KEY,
    queryFn: async (): Promise<AgentStatusCache> => {
      const result = await window.api.agentStatus.list()
      if (!result.success) {
        throw new AgentStatusRequestError(
          result.code ?? 'unknown',
          result.error ?? 'Failed to fetch agent statuses'
        )
      }
      return { items: result.items ?? [], remoteError: result.remoteError ?? null }
    },
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000
  })

  // A partial failure is re-raised as the same typed error a total failure
  // produces, so `error.code` keeps meaning what every consumer already thinks
  // it means — `reauth_required` still reaches the re-authenticate panel. What
  // changes is that `data` can be non-empty *at the same time*, which is why
  // the consumers render the error above the rows rather than instead of them.
  const partial = query.data?.remoteError ?? null
  return {
    data: query.data?.items ?? [],
    isLoading: query.isLoading,
    error: toRequestError(query.error, partial),
    refetch: async () => {
      try {
        const r = await query.refetch()
        return !r.isError
      } catch {
        return false
      }
    }
  }
}

function useAgentStatusFetch(intent: StatusRefreshIntent) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (agentId: string) => {
      const profile = useAuthStore.getState().currentUser
      try {
        const result = await window.api.agentStatus.get({ agentId, intent })
        if (useAuthStore.getState().currentUser !== profile) return { success: true as const, item: null }
        if (result.success && result.item) patchAgentStatusCache(queryClient, [result.item])
        return result
      } catch (error) {
        if (useAuthStore.getState().currentUser !== profile) return { success: true as const, item: null }
        throw error
      }
    }
  })
}

/** Explicit per-agent gesture; the source may execute its declared refresh command. */
export function useForceRefreshAgentStatus() {
  return useAgentStatusFetch('manual')
}

/** Passive read of already reported status. */
export function useRereadAgentStatus() {
  return useAgentStatusFetch('read')
}

/** The source decides what a completed turn should refresh; never runs a local command. */
export function useAfterTurnAgentStatus() {
  return useAgentStatusFetch('after_turn')
}

/** Outcome of a "Refresh all" fan-out, so callers can give honest feedback. */
export interface ForceRefreshAllResult {
  /** Agents whose snapshot was successfully re-fetched and patched in. */
  refreshed: number
  /** Agents whose force-refresh returned an error (excludes silent 429 no-ops). */
  failed: number
  /** At least one agent failed with `reauth_required` — the session expired. */
  reauthRequired: boolean
}

/** Refresh the visible set. Main enforces each source's passive batch policy. */
export function useForceRefreshAllAgentStatuses() {
  const queryClient = useQueryClient()
  return useMutation<ForceRefreshAllResult>({
    mutationFn: async () => {
      const profile = useAuthStore.getState().currentUser
      const cached = queryClient.getQueryData<AgentStatusCache>(AGENT_STATUS_KEY)?.items ?? []
      const agentIds = cached.map((s) => s.agentId)
      if (agentIds.length === 0) {
        // No envs to force — fall back to the cache-only list. Its own error
        // (incl. reauth) surfaces through the `useAgentStatus` query state.
        await queryClient.refetchQueries({ queryKey: AGENT_STATUS_KEY })
        return { refreshed: 0, failed: 0, reauthRequired: false }
      }
      const results = await Promise.allSettled(
        agentIds.map((agentId) =>
          window.api.agentStatus.get({ agentId, intent: 'batch' })
        )
      )
      if (useAuthStore.getState().currentUser !== profile) return { refreshed: 0, failed: 0, reauthRequired: false }
      const fresh: AgentStatusSnapshot[] = []
      let failed = 0
      let reauthRequired = false
      for (const r of results) {
        if (r.status === 'rejected') {
          failed++
          continue
        }
        const value = r.value
        if (value.success) {
          // `item: null` is a swallowed 429 (rate-limited) — a no-op, not a failure.
          if (value.item) fresh.push(value.item)
        } else {
          failed++
          if (value.code === 'reauth_required') reauthRequired = true
        }
      }
      patchAgentStatusCache(queryClient, fresh)
      return { refreshed: fresh.length, failed, reauthRequired }
    }
  })
}

/** Upsert fresh snapshots into the shared batch cache, keyed by `agentId`. */
function patchAgentStatusCache(
  queryClient: ReturnType<typeof useQueryClient>,
  fresh: AgentStatusSnapshot[]
): void {
  if (fresh.length === 0) return
  queryClient.setQueryData<AgentStatusCache>(AGENT_STATUS_KEY, (prev) => {
    const next = prev ? prev.items.slice() : []
    for (const item of fresh) {
      const idx = next.findIndex((s) => s.agentId === item.agentId)
      if (idx === -1) next.push(item)
      else next[idx] = item
    }
    // A fresh per-agent snapshot says nothing about the batch route's health,
    // so a standing partial-failure marker survives the patch.
    return { items: next, remoteError: prev?.remoteError ?? null }
  })
}
