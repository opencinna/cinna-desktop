import { useEffect } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { RunQueueView } from '../../../shared/ipcPayloads'

/**
 * The messages main is holding for this chat until its running turn ends.
 *
 * Main pushes `run:queue-changed` with the queue as it now stands on every
 * change — a message queued, sent, removed or held — and that view goes
 * straight into the cache. Refetching it instead lost the order main sends
 * in: a drain announces before it starts the turn, and a `queue-list` round
 * trip could land after the drained message's saved row, so the transcript
 * showed the message twice — still badged as queued, and as the row.
 */
export function useRunQueue(chatId: string | null): UseQueryResult<RunQueueView> {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!chatId) return
    return window.api.run.onQueueChanged((payload) => {
      if (payload.chatId === chatId) queryClient.setQueryData(['run-queue', chatId], payload.view)
    })
  }, [chatId, queryClient])
  return useQuery({
    queryKey: ['run-queue', chatId],
    queryFn: () => window.api.run.queueList(chatId!),
    enabled: !!chatId
  })
}
