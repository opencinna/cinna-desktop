import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

type ListResult = Awaited<ReturnType<typeof window.api.agentStatus.list>>
export type AgentStatusSnapshot = NonNullable<ListResult['items']>[number]

const AGENT_STATUS_KEY = ['agent-status'] as const

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
export function useAgentStatus(): {
  data: AgentStatusSnapshot[]
  isLoading: boolean
  error: AgentStatusRequestError | null
  /** Resolves `true` when the refetch succeeded, `false` on any error. */
  refetch: () => Promise<boolean>
} {
  const query = useQuery({
    queryKey: AGENT_STATUS_KEY,
    queryFn: async () => {
      const result = await window.api.agentStatus.list()
      if (!result.success) {
        throw new AgentStatusRequestError(
          result.code ?? 'unknown',
          result.error ?? 'Failed to fetch agent statuses'
        )
      }
      return result.items ?? []
    },
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000
  })

  return {
    data: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error instanceof AgentStatusRequestError ? query.error : null,
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

function useAgentStatusFetch(forceRefresh: boolean) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) => window.api.agentStatus.get({ agentId, forceRefresh }),
    onSuccess: (result) => {
      if (!result.success || !result.item) return
      patchAgentStatusCache(queryClient, [result.item])
    }
  })
}

/**
 * One-shot per-agent refresh. For a remote agent `force_refresh=true` asks the
 * platform to re-read STATUS.md from the running env, rate-limited server-side
 * to 1/30s; 429s are swallowed upstream and return `item: null`. For a folder
 * agent it runs the manifest's `status_refresh_command`. **A user has to have
 * asked for this** — see {@link useRereadAgentStatus} for the cheap variant.
 * On success, patches the batch cache so list consumers update in place.
 */
export function useForceRefreshAgentStatus() {
  return useAgentStatusFetch(true)
}

/**
 * One agent's status *without* forcing a refresh — for a folder agent that is a
 * read of `app-data/storage/STATUS.md` off local disk and nothing else.
 *
 * This exists because "the turn ended, re-read the status" and "the user pressed
 * Refresh" are different requests, and for a folder agent the difference is a
 * subprocess. `status_refresh_command` runs under the agent's turn lock, so
 * firing it after every chat turn would (a) run the agent's own health check —
 * the template's `collect()`, which is where real work goes — on every message
 * nobody asked for it on, and (b) hold the lock the user's *next* message needs,
 * so a background refresh could refuse a message the user just sent. It is also
 * redundant in the common case: an agent that updates its own STATUS.md does so
 * during the turn, which is the whole design. A disk re-read gets that to the
 * tray immediately, takes no lock, and spawns nothing.
 */
export function useRereadAgentStatus() {
  return useAgentStatusFetch(false)
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

/**
 * Mass refresh used by the overlay and tray "Refresh all" buttons. The batch
 * `list` route is cache-only, so a genuine refresh has to fan out per-agent
 * `force_refresh=true` calls (one per currently-known agent) — this is what
 * wakes a suspended env and re-reads STATUS.md, including for A2A agents. Each
 * fresh snapshot is patched back into the batch cache as it lands. When nothing
 * is cached yet there are no envs to force-refresh, so we fall back to the
 * cache-only list refetch to populate the grid.
 *
 * Returns a {@link ForceRefreshAllResult} (never throws on per-agent failure, so
 * one dead env doesn't abort the batch) — callers branch on it to flash
 * success/error and surface an expired session.
 */
export function useForceRefreshAllAgentStatuses() {
  const queryClient = useQueryClient()
  return useMutation<ForceRefreshAllResult>({
    mutationFn: async () => {
      const cached = queryClient.getQueryData<AgentStatusSnapshot[]>(AGENT_STATUS_KEY) ?? []
      const agentIds = cached.map((s) => s.agentId)
      if (agentIds.length === 0) {
        // No envs to force — fall back to the cache-only list. Its own error
        // (incl. reauth) surfaces through the `useAgentStatus` query state.
        await queryClient.refetchQueries({ queryKey: AGENT_STATUS_KEY })
        return { refreshed: 0, failed: 0, reauthRequired: false }
      }
      const results = await Promise.allSettled(
        agentIds.map((agentId) => window.api.agentStatus.get({ agentId, forceRefresh: true }))
      )
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
  queryClient.setQueryData<AgentStatusSnapshot[]>(AGENT_STATUS_KEY, (prev) => {
    const next = prev ? prev.slice() : []
    for (const item of fresh) {
      const idx = next.findIndex((s) => s.agentId === item.agentId)
      if (idx === -1) next.push(item)
      else next[idx] = item
    }
    return next
  })
}
