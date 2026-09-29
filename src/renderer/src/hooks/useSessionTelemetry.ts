import { useCallback, useEffect } from 'react'
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { SessionTelemetry, SessionTelemetryMeasureResult } from '../../../shared/sessionTelemetry'

export const sessionTelemetryKey = (chatId: string | null) => ['sessionTelemetry', chatId] as const

/**
 * When each chat last received a push, per query client — the same guard as
 * `useSessionActivity`: a `get` reply that resolves after a newer push must
 * not overwrite it. An entry lives while a mounted hook listens to that chat.
 */
interface PushEntry {
  holders: number
  lastPush: number
}
const pushLog = new WeakMap<QueryClient, Map<string, PushEntry>>()
let tick = 0

function pushesFor(client: QueryClient): Map<string, PushEntry> {
  let entries = pushLog.get(client)
  if (!entries) {
    entries = new Map()
    pushLog.set(client, entries)
  }
  return entries
}

/**
 * The query is returned whole, not spread: spreading reads every property of
 * TanStack's tracked result, which then re-renders the caller on changes it
 * never looks at (`isFetching` on each refetch).
 */
export interface UseSessionTelemetryResult {
  query: UseQueryResult<SessionTelemetry | null>
  /**
   * Measure the chat's context by category now (Claude, between turns). The
   * measurement lands in `query.data.context.categories` through the push; the
   * answer only says whether it was taken, or why not.
   */
  measureContext: () => Promise<SessionTelemetryMeasureResult>
}

/**
 * What this chat's agent session reports it used: the model that answered,
 * tokens and cost so far, the context window, the login kind. `null` for a
 * chat with none yet, or one main does not recognise as this profile's.
 *
 * Read once, then kept current by main's push, which carries the whole state.
 */
export function useSessionTelemetry(chatId: string | null): UseSessionTelemetryResult {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!chatId) return
    const entries = pushesFor(queryClient)
    const entry = entries.get(chatId) ?? { holders: 0, lastPush: 0 }
    entry.holders += 1
    entries.set(chatId, entry)
    const unsubscribe = window.api.sessionTelemetry.onChanged((payload) => {
      if (payload.chatId !== chatId) return
      entry.lastPush = ++tick
      queryClient.setQueryData(sessionTelemetryKey(chatId), payload.telemetry)
    })
    return () => {
      unsubscribe()
      entry.holders -= 1
      if (entry.holders === 0 && entries.get(chatId) === entry) entries.delete(chatId)
    }
  }, [chatId, queryClient])
  const measureContext = useCallback(
    (): Promise<SessionTelemetryMeasureResult> =>
      chatId ? window.api.sessionTelemetry.measureContext(chatId) : Promise.resolve({ ok: false, code: 'chat_not_found' }),
    [chatId]
  )
  const query = useQuery({
    queryKey: sessionTelemetryKey(chatId),
    queryFn: async (): Promise<SessionTelemetry | null> => {
      const startedAt = tick
      const result = await window.api.sessionTelemetry.get(chatId!)
      const lastPush = pushesFor(queryClient).get(chatId!)?.lastPush ?? 0
      if (lastPush > startedAt) {
        const pushed = queryClient.getQueryData<SessionTelemetry | null>(sessionTelemetryKey(chatId))
        if (pushed) return pushed
      }
      return result.ok ? result.telemetry : null
    },
    enabled: !!chatId,
    // Pushes are heard only while a view of this chat is mounted.
    staleTime: 0
  })
  return { query, measureContext }
}
