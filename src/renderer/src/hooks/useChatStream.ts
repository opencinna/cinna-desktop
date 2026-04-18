import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import type { ContentKind } from '../../../shared/messageParts'

type LlmEvent = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  result?: unknown
  error?: string
  errorDetail?: string
  requestId?: string
  provider?: string
}

type AgentEvent = {
  type: string
  text?: string
  kind?: ContentKind
  toolName?: string
  requestId?: string
  taskId?: string
  contextId?: string
  state?: string
  error?: string
}

/**
 * Start a chat send and connect the stream to the chat store + query cache.
 * Returns void — callers should not await; streaming is fire-and-forget.
 */
export function useChatStream(): {
  startLlm: (chatId: string, content: string) => void
  startAgent: (agentId: string, chatId: string, content: string) => void
  cancel: (requestId: string) => void
} {
  const queryClient = useQueryClient()
  const { startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, finishStreaming, clearStreamingBlocks, stopStreaming, setPendingUserMessage } =
    useChatStore()

  const handleLlm = useCallback(
    (chatId: string, event: LlmEvent): void => {
      switch (event.type) {
        case 'request-id':
          startStreaming(event.requestId ?? '')
          break
        case 'delta':
          appendDelta(event.text!)
          break
        case 'tool_use':
          addToolCall({
            id: event.id!,
            name: event.name!,
            input: event.input!,
            provider: event.provider
          })
          break
        case 'tool_result':
          resolveToolCall(event.id!, event.result)
          break
        case 'tool_error':
          failToolCall(event.id!, event.error!)
          break
        case 'done':
          // Keep streaming blocks visible (cursor already hidden via isStreaming=false)
          // until the DB message is fetched, then remove them — no visual gap.
          finishStreaming()
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
            queryClient.invalidateQueries({ queryKey: ['chats'] })
          ]).finally(() => clearStreamingBlocks())
          break
        case 'error':
          console.error('LLM error:', event.error)
          stopStreaming()
          queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
          break
      }
    },
    [startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, finishStreaming, clearStreamingBlocks, stopStreaming, queryClient]
  )

  const handleAgent = useCallback(
    (chatId: string, event: AgentEvent): void => {
      switch (event.type) {
        case 'request-id':
          startStreaming(event.requestId ?? '')
          break
        case 'delta':
          appendDelta(event.text!, event.kind ?? 'text', event.toolName)
          break
        case 'done':
          finishStreaming()
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
            queryClient.invalidateQueries({ queryKey: ['chats'] })
          ]).finally(() => clearStreamingBlocks())
          break
        case 'error':
          console.error('Agent error:', event.error)
          stopStreaming()
          queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
          break
      }
    },
    [startStreaming, appendDelta, finishStreaming, clearStreamingBlocks, stopStreaming, queryClient]
  )

  const startLlm = useCallback(
    (chatId: string, content: string): void => {
      setPendingUserMessage(content)
      try {
        window.api.llm.sendMessage(chatId, content, (event) => handleLlm(chatId, event))
      } catch {
        stopStreaming()
        return
      }
      // User message is saved by main before streaming begins — refetch once it settles
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      }, 300)
    },
    [handleLlm, queryClient, setPendingUserMessage, stopStreaming]
  )

  const startAgent = useCallback(
    (agentId: string, chatId: string, content: string): void => {
      setPendingUserMessage(content)
      try {
        window.api.agents.sendMessage(agentId, chatId, content, (event) => handleAgent(chatId, event))
      } catch {
        stopStreaming()
        return
      }
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      }, 300)
    },
    [handleAgent, queryClient, setPendingUserMessage, stopStreaming]
  )

  const cancel = useCallback((requestId: string): void => {
    window.api.llm.cancel(requestId)
    window.api.agents.cancelMessage(requestId)
  }, [])

  return { startLlm, startAgent, cancel }
}
