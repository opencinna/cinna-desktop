import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import { useAuthStore } from '../stores/auth.store'
import { useForceRefreshAgentStatus } from './useAgentStatus'
import type { MessageAttachment } from '../../../shared/attachments'
import type { AgentStreamEvent } from '../../../shared/agentStreamEvents'
import type { LlmStreamEvent } from '../../../shared/llmStreamEvents'

// Receiver-side type — defined in `src/shared/llmStreamEvents.ts` and shared
// with the sender (chatStreamingService) so adding a new event variant or
// field flags drift at compile time on both sides.
type LlmEvent = LlmStreamEvent

// Receiver-side type — defined in `src/shared/agentStreamEvents.ts` and shared
// with the sender (a2aStreamingService + StreamPartsAccumulator) so adding a
// new event variant or field flags drift at compile time on both sides.
type AgentEvent = AgentStreamEvent

export interface StartLlmOptions {
  catchupPacket?: string
  attachments?: MessageAttachment[]
}

export interface StartAgentOptions {
  rewrittenText?: string | null
  originalText?: string | null
  catchupPacket?: string
  attachments?: MessageAttachment[]
}

/**
 * Start a chat send and connect the stream to the chat store + query cache.
 * Returns void — callers should not await; streaming is fire-and-forget.
 */
export function useChatStream(): {
  startLlm: (chatId: string, content: string, opts?: StartLlmOptions) => void
  startAgent: (agentId: string, chatId: string, content: string, opts?: StartAgentOptions) => void
  cancel: (requestId: string) => void
} {
  const queryClient = useQueryClient()
  const { startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, finishStreaming, clearStreamingBlocks, stopStreaming, setPendingUserMessage } =
    useChatStore()
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const forceRefreshAgentStatus = useForceRefreshAgentStatus()

  const handleLlm = useCallback(
    (chatId: string, event: LlmEvent): void => {
      switch (event.type) {
        case 'request-id':
          startStreaming(event.requestId)
          break
        case 'delta':
          appendDelta(event.text)
          break
        case 'tool_use':
          addToolCall({
            id: event.id,
            name: event.name,
            input: event.input,
            provider: event.provider
          })
          break
        case 'tool_result':
          // LLM-side completion event: pairs a tool-use id with its result.
          // Distinct from the A2A 'tool_result' *content kind* handled by
          // handleAgent (which streams stdout/stderr text chunks as deltas).
          resolveToolCall(event.id, event.result)
          break
        case 'tool_error':
          failToolCall(event.id, event.error)
          break
        case 'done':
          // Keep streaming blocks visible (cursor already hidden via isStreaming=false)
          // until the DB message is fetched, then remove them — no visual gap.
          finishStreaming()
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
            queryClient.invalidateQueries({ queryKey: ['chats'] }),
            queryClient.invalidateQueries({ queryKey: ['jobs'] })
          ]).finally(() => clearStreamingBlocks())
          break
        case 'error':
          // The error has already been persisted main-side (`chatStreamingService`
          // calls `messageRepo.saveError`) and will render as a `SystemMessage`
          // bubble once `['chat', chatId]` refetches. Don't also call
          // `setSendError` here — it would duplicate the same text as a
          // transient banner above the composer.
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
          startStreaming(event.requestId)
          break
        case 'delta':
          appendDelta(
            event.text,
            event.kind,
            event.toolName,
            event.toolInput,
            event.toolId,
            event.toolStream,
            event.commandInvocation
          )
          break
        case 'done':
          finishStreaming()
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
            queryClient.invalidateQueries({ queryKey: ['chats'] }),
            queryClient.invalidateQueries({ queryKey: ['jobs'] })
          ]).finally(() => clearStreamingBlocks())
          break
        case 'error':
          // Agent errors are already persisted by `agent_a2a.ipc` /
          // `a2aStreamingService` as a `SystemMessage` row (with the typed
          // `code` for the reauth chip when applicable). Don't also surface
          // them as a transient banner — that would duplicate the in-bubble
          // error and strip the inline action button.
          console.error('Agent error:', event.error)
          stopStreaming()
          queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
          break
      }
    },
    [startStreaming, appendDelta, finishStreaming, clearStreamingBlocks, stopStreaming, queryClient]
  )

  const startLlm = useCallback(
    (chatId: string, content: string, opts?: StartLlmOptions): void => {
      setPendingUserMessage(content)
      try {
        window.api.llm.sendMessage(
          chatId,
          content,
          (event) => handleLlm(chatId, event),
          {
            catchupPacket: opts?.catchupPacket,
            attachments: opts?.attachments
          }
        )
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
    (agentId: string, chatId: string, content: string, opts?: StartAgentOptions): void => {
      setPendingUserMessage(content)
      try {
        window.api.agents.sendMessage(
          agentId,
          chatId,
          content,
          (event) => {
            handleAgent(chatId, event)
            // When the agent finishes (or errors out), it may have updated its
            // STATUS.md during the turn — pull a fresh snapshot so tiles in the
            // status overlay / title-bar dot stay in sync. Backend rate-limits
            // 1/30s per env; 429 is swallowed upstream. Cinna-only feature.
            if (isCinnaUser && (event.type === 'done' || event.type === 'error')) {
              forceRefreshAgentStatus.mutate(agentId)
            }
          },
          opts
        )
      } catch {
        stopStreaming()
        return
      }
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      }, 300)
    },
    [handleAgent, queryClient, setPendingUserMessage, stopStreaming, isCinnaUser, forceRefreshAgentStatus]
  )

  const cancel = useCallback((requestId: string): void => {
    window.api.llm.cancel(requestId)
    window.api.agents.cancelMessage(requestId)
  }, [])

  return { startLlm, startAgent, cancel }
}
