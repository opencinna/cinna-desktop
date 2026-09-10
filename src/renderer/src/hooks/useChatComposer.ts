import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStream } from './useChatStream'
import { useChatStore } from '../stores/chat.store'
import { routingOf, type RunTarget } from '../../../shared/chatRouting'
import type { MessageAttachment } from '../../../shared/attachments'

type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
type OnDemandAgents = Awaited<ReturnType<typeof window.api.chat.listOnDemandAgents>>

/**
 * The chat composer's send.
 *
 * **It no longer decides where the message goes.** It used to: `chat.agentId &&
 * !chat.orchestrated` picked between two IPC channels, and four other places
 * re-derived the same sentence to answer the same question about the same chat.
 * Main reads `chats.router` now and resolves the answerer itself.
 *
 * What is left here is the one thing main cannot know — which agent the user
 * addressed — and the renderer's own copy of the answer, used for the
 * post-turn bookkeeping in `useChatStream` (whose status to re-read). Both come
 * from the same shared helper main uses, so the two cannot drift into different
 * rules; they can only differ on a cache that is a moment stale, and main's
 * answer is the one that runs.
 */
export function useChatComposer(chatId: string | null): {
  submit: (input: string, attachments?: MessageAttachment[]) => Promise<void>
} {
  const queryClient = useQueryClient()
  const { startRun } = useChatStream()
  const addressedAgentByChat = useChatStore((s) => s.addressedAgentByChat)

  const submit = useCallback(
    async (input: string, attachments?: MessageAttachment[]): Promise<void> => {
      const trimmed = input.trim()
      if (!trimmed || !chatId) return
      const chat = queryClient.getQueryData<CachedChat>(['chat', chatId])
      if (!chat) return

      startRun(chatId, trimmed, {
        attachments,
        target: answererFor(queryClient, chat, chatId, addressedAgentByChat[chatId])
      })
    },
    [chatId, queryClient, startRun, addressedAgentByChat]
  )

  return { submit }
}

/**
 * Who the renderer believes will answer, from the caches it already holds.
 *
 * The sticky default (`lastAddressed`) is read out of the chat's own messages
 * rather than kept anywhere: the transcript is the record, and a second copy of
 * it could disagree with what the user can see. Main reads the same thing from
 * the same rows.
 */
function answererFor(
  queryClient: ReturnType<typeof useQueryClient>,
  chat: NonNullable<CachedChat>,
  chatId: string,
  addressed: string | undefined
): RunTarget {
  const routing = routingOf(chat)
  if (routing.router !== 'human') return routing.answerer()
  const attached = (
    queryClient.getQueryData<OnDemandAgents>(['chat-on-demand-agent', chatId]) ?? []
  ).map((row) => row.agentId)
  const lastAddressed = [...(chat.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'user' && m.addressedAgentId)?.addressedAgentId
  return routing.answerer({ addressed, lastAddressed, attached })
}
