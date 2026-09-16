import { useEffect } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { SessionActivitySnapshot } from '../../../shared/sessionActivity'

export const sessionActivityKey = (chatId: string | null) => ['sessionActivity', chatId] as const

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
    return window.api.sessionActivity.onChanged((payload) => {
      if (payload.chatId === chatId) queryClient.setQueryData(sessionActivityKey(chatId), payload.snapshot)
    })
  }, [chatId, queryClient])
  return useQuery({
    queryKey: sessionActivityKey(chatId),
    queryFn: async (): Promise<SessionActivitySnapshot> => {
      const result = await window.api.sessionActivity.get(chatId!)
      return result.ok ? result.snapshot : { chatId: chatId!, items: [] }
    },
    enabled: !!chatId,
    // Pushes are only heard while a view of this chat is mounted, so a cached
    // snapshot may have missed the change that ended an item. Read again on
    // every mount rather than show that item as running.
    staleTime: 0
  })
}
