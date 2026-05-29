import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStream } from './useChatStream'
import type { MessageAttachment } from '../../../shared/attachments'

type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>

/**
 * Routing chokepoint for the chat composer. A chat is one of two shapes:
 *
 *  - **Direct A2A** — agent-rooted (`agentId` set) and not orchestrated. The
 *    bound agent is the conversation's voice; the message streams straight to
 *    it over A2A.
 *  - **Orchestrated / plain LLM** — `agentId` null (orchestrated chats detach
 *    their root at promotion) or the `orchestrated` flag set. The local model
 *    conducts, calling any attached agents/MCPs as tools.
 *
 * Bringing a second counterparty into a direct-A2A chat (the in-chat `@`-agent
 * gesture) promotes it to orchestrated — handled in `ChatInput`, not here. By
 * the time `submit` runs, the chat row already reflects the final shape, so
 * the routing decision is a single read of the fresh cache snapshot.
 */
export function useChatComposer(chatId: string | null): {
  submit: (input: string, attachments?: MessageAttachment[]) => Promise<void>
} {
  const queryClient = useQueryClient()
  const { startLlm, startAgent } = useChatStream()

  const submit = useCallback(
    async (input: string, attachments?: MessageAttachment[]): Promise<void> => {
      const trimmed = input.trim()
      if (!trimmed || !chatId) return
      const chat = queryClient.getQueryData<CachedChat>(['chat', chatId])
      if (!chat) return

      // Direct A2A: a single bound agent that hasn't been promoted. Everything
      // else (orchestrated or plain LLM) routes through the local model.
      if (chat.agentId && !chat.orchestrated) {
        startAgent(chat.agentId, chatId, trimmed, { attachments })
        return
      }
      startLlm(chatId, trimmed, { attachments })
    },
    [chatId, queryClient, startAgent, startLlm]
  )

  return { submit }
}
