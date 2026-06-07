import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'

// Cached `['chat', chatId]` shape — used to snapshot the persisted user-message
// count at send time so the optimistic bubble retires the instant a new user
// row lands (see `pendingUserMessage` / `PendingUserMessage`).
type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
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
  attachments?: MessageAttachment[]
}

export interface StartAgentOptions {
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
  const { startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, appendToolSubEvent, finishStreaming, clearStreamingBlocks, stopStreaming, setPendingUserMessage } =
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
            provider: event.provider,
            providerType: event.providerType,
            agentId: event.providerAgentId
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
        case 'tool_subevent':
          // Nested A2A event from an agent-backed tool call (orchestrated
          // mode) — accumulate into that tool's live sub-thread.
          appendToolSubEvent(event.toolCallId, event.event)
          break
        case 'done':
          // Keep streaming blocks visible (cursor already hidden via isStreaming=false)
          // until the DB message is fetched, then remove them — no visual gap.
          // The optimistic user bubble is retired in the same `.finally`: by the
          // time the refetch settles its persisted row is in `messages`, so the
          // clear is gap-free and bounds the optimistic copy to this turn.
          finishStreaming()
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
            queryClient.invalidateQueries({ queryKey: ['chats'] }),
            queryClient.invalidateQueries({ queryKey: ['jobs'] })
          ]).finally(() => {
            clearStreamingBlocks()
            setPendingUserMessage(null)
          })
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
    [startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, appendToolSubEvent, finishStreaming, clearStreamingBlocks, stopStreaming, setPendingUserMessage, queryClient]
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
            event.commandInvocation,
            event.file
          )
          break
        case 'done':
          // Retire the optimistic user bubble alongside the streaming blocks
          // once the refetch lands — its persisted row is in `messages` by then.
          finishStreaming()
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
            queryClient.invalidateQueries({ queryKey: ['chats'] }),
            queryClient.invalidateQueries({ queryKey: ['jobs'] })
          ]).finally(() => {
            clearStreamingBlocks()
            setPendingUserMessage(null)
          })
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
    [startStreaming, appendDelta, finishStreaming, clearStreamingBlocks, stopStreaming, setPendingUserMessage, queryClient]
  )

  // Count the user rows already persisted for this chat, so the optimistic
  // bubble can be retired the instant a *new* one appears (count grows past
  // this baseline) — robust even when the new message repeats earlier text.
  const snapshotUserCount = useCallback(
    (chatId: string): number => {
      const cached = queryClient.getQueryData<CachedChat>(['chat', chatId])
      return cached?.messages?.filter((m) => m.role === 'user').length ?? 0
    },
    [queryClient]
  )

  const startLlm = useCallback(
    (chatId: string, content: string, opts?: StartLlmOptions): void => {
      setPendingUserMessage({ content, baselineUserCount: snapshotUserCount(chatId) })
      try {
        window.api.llm.sendMessage(
          chatId,
          content,
          (event) => handleLlm(chatId, event),
          { attachments: opts?.attachments }
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
    [handleLlm, queryClient, setPendingUserMessage, snapshotUserCount, stopStreaming]
  )

  const startAgent = useCallback(
    (agentId: string, chatId: string, content: string, opts?: StartAgentOptions): void => {
      setPendingUserMessage({ content, baselineUserCount: snapshotUserCount(chatId) })
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
    [handleAgent, queryClient, setPendingUserMessage, snapshotUserCount, stopStreaming, isCinnaUser, forceRefreshAgentStatus]
  )

  const cancel = useCallback((requestId: string): void => {
    window.api.llm.cancel(requestId)
    window.api.agents.cancelMessage(requestId)
  }, [])

  return { startLlm, startAgent, cancel }
}
