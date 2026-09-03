import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { isFolderAgentId } from '../../../shared/localAgents'

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
 * calls (one per currently-known agent). Each fresh snapshot is patched back
 * into the batch cache as it lands. When nothing is cached yet there is nothing
 * to fan out to, so we fall back to the cache-only list refetch to populate the
 * grid.
 *
 * **A folder agent is deliberately re-read here, not force-refreshed** — the
 * one place the two agent kinds are asked different questions, because
 * `forceRefresh: true` does not mean the same thing for both. For a remote
 * agent it means *fetch what exists now*: it wakes a suspended env so the
 * platform re-reads its STATUS.md, and it is the only way past a server-side
 * cache. For a folder agent it means *make the agent recompute its status*,
 * running `status_refresh_command` as a subprocess under that agent's turn
 * lock — the scaffolded script's `collect()` is where an author's real health
 * check goes. "Refresh all" is a glance-level gesture asking for the panel to
 * be current, and for a folder agent the file on disk already is the truth, so
 * a re-read answers it completely and instantly.
 *
 * Two consequences settle it. This is `Promise.allSettled` over *every* cached
 * agent, so one click would start every folder agent's script at once — the
 * per-agent locks make that safe, not cheap — and each running script refuses
 * that agent's chat and page-editor saves for as long as it takes. And the
 * tray's spinner holds until the whole batch settles, so a single 30-second
 * status script makes a menu-bar button spin for 30 seconds. Running the
 * command stays on the overlay's **per-card** Refresh: singular, targeted,
 * explicitly aimed at one agent — and the one surface that reports when it
 * fails.
 *
 * Returns a {@link ForceRefreshAllResult} (never throws on per-agent failure, so
 * one dead env doesn't abort the batch) — callers branch on it to flash
 * success/error and surface an expired session.
 */
export function useForceRefreshAllAgentStatuses() {
  const queryClient = useQueryClient()
  return useMutation<ForceRefreshAllResult>({
    mutationFn: async () => {
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
          window.api.agentStatus.get({ agentId, forceRefresh: !isFolderAgentId(agentId) })
        )
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
