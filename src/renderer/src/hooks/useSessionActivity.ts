import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { SessionActivitySnapshot } from '../../../shared/sessionActivity'

export const sessionActivityKey = (chatId: string | null) => ['sessionActivity', chatId] as const

/**
 * When each chat last received a push, per query client, as a tick of one
 * counter that only grows.
 *
 * What it defends against: main answers `sessionActivity:get`, then pushes a
 * change, and the push is delivered first — the invoke's reply still has the
 * bridge and TanStack's promise/notify chain to get through, so it resolves
 * after the push already wrote the cache. Without the check that older reply
 * would overwrite the newer pushed snapshot and a running item would vanish
 * (or an ended one come back) until the next push.
 *
 * An entry lives while at least one mounted hook listens to that chat
 * (`holders`), so the map is bounded by the chats on screen.
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
 * The subagents and background processes this chat's agent session is
 * running, and the ones that recently ended.
 *
 * Read once, then kept current by main's push: each `session-activity:changed`
 * carries the chat's whole snapshot, which goes straight into the cache. A chat
 * main does not recognise as this profile's reads as having no activity.
 */
export function useSessionActivity(chatId: string | null): UseQueryResult<SessionActivitySnapshot> {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!chatId) return
    const entries = pushesFor(queryClient)
    const entry = entries.get(chatId) ?? { holders: 0, lastPush: 0 }
    entry.holders += 1
    entries.set(chatId, entry)
    const unsubscribe = window.api.sessionActivity.onChanged((payload) => {
      if (payload.chatId !== chatId) return
      entry.lastPush = ++tick
      queryClient.setQueryData(sessionActivityKey(chatId), payload.snapshot)
    })
    return () => {
      unsubscribe()
      entry.holders -= 1
      if (entry.holders === 0 && entries.get(chatId) === entry) entries.delete(chatId)
    }
  }, [chatId, queryClient])
  return useQuery({
    queryKey: sessionActivityKey(chatId),
    queryFn: async (): Promise<SessionActivitySnapshot> => {
      const startedAt = tick
      const result = await window.api.sessionActivity.get(chatId!)
      // A push landed while this read was in flight: the pushed snapshot is
      // newer than whatever the read saw, so keep it.
      const lastPush = pushesFor(queryClient).get(chatId!)?.lastPush ?? 0
      if (lastPush > startedAt) {
        const pushed = queryClient.getQueryData<SessionActivitySnapshot>(sessionActivityKey(chatId))
        if (pushed) return pushed
      }
      return result.ok ? result.snapshot : { chatId: chatId!, items: [] }
    },
    enabled: !!chatId,
    // Pushes are only heard while a view of this chat is mounted, so a cached
    // snapshot may have missed the change that ended an item. Read again on
    // every mount rather than show that item as running.
    staleTime: 0
  })
}
