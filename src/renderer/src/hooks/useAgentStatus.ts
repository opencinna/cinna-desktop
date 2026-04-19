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
  refetch: () => void
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
    refetch: () => query.refetch()
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
      const fresh = result.item
      queryClient.setQueryData<AgentStatusSnapshot[]>(AGENT_STATUS_KEY, (prev) => {
        if (!prev) return prev
        const idx = prev.findIndex((s) => s.agentId === fresh.agentId)
        if (idx === -1) return [...prev, fresh]
        const next = prev.slice()
        next[idx] = fresh
        return next
      })
    }
  })
}
