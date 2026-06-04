import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'

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
 * backend route (spec recommends 30–60 s). Only runs for cinna_user accounts —
 * local users have no remote agents to report status.
 */
export function useAgentStatus(): {
  data: AgentStatusSnapshot[]
  isLoading: boolean
  error: AgentStatusRequestError | null
  /** Resolves `true` when the refetch succeeded, `false` on any error. */
  refetch: () => Promise<boolean>
} {
  const currentUser = useAuthStore((s) => s.currentUser)
  const enabled = currentUser?.type === 'cinna_user'

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
    enabled,
    refetchInterval: enabled ? 45_000 : false,
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

/**
 * One-shot per-agent refresh. `force_refresh=true` is rate-limited server-side
 * to 1/30s per env; 429s are swallowed upstream and return `item: null`.
 * On success, patches the batch cache so list consumers update in place.
 */
export function useForceRefreshAgentStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) =>
      window.api.agentStatus.get({ agentId, forceRefresh: true }),
    onSuccess: (result) => {
      if (!result.success || !result.item) return
      patchAgentStatusCache(queryClient, [result.item])
    }
  })
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
