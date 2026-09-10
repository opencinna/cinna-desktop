import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'

// Cached `['chat', chatId]` shape — used to snapshot the persisted user-message
// count at send time so the optimistic bubble retires the instant a new user
// row lands (see `pendingUserMessage` / `PendingUserMessage`).
type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
import { useAuthStore } from '../stores/auth.store'
import { useForceRefreshAgentStatus, useRereadAgentStatus } from './useAgentStatus'
import { isFolderAgentId } from '../../../shared/localAgents'
import type { MessageAttachment } from '../../../shared/attachments'
// Receiver-side type — defined in `src/shared/runEvents.ts` and shared with
// every sender (chatStreamingService, a2aStreamingService, the local turn
// runners) so adding a new event variant or field flags drift at compile time
// on both sides.
import type { RunEvent } from '../../../shared/runEvents'
import type { RunTarget } from '../../../shared/chatRouting'

export interface StartRunOptions {
  attachments?: MessageAttachment[]
  /**
   * Who the caller believes will answer, from `routingOf(chat).answerer(…)`.
   *
   * Main resolves this again from the chat row and its own answer is the one
   * that runs — this is what the *renderer* needs it for: which agent to
   * address (`human` chats), and whose status and readiness to re-read when the
   * turn ends. Omit it and main still routes the message; the renderer just
   * does no per-agent bookkeeping afterwards.
   */
  target?: RunTarget
}

/**
 * Start a chat send and connect the stream to the chat store + query cache.
 * Returns void — callers should not await; streaming is fire-and-forget.
 *
 * **One entry point, because there is one channel.** `startLlm` and
 * `startAgent` were two, and picking between them was the routing decision —
 * re-derived at every call site from `chat.agentId && !chat.orchestrated`.
 * Phase 4 moved that decision into main (`run:send` reads `chats.router`), so
 * what is left here is one send and one handler.
 */
export function useChatStream(): {
  startRun: (chatId: string, content: string, opts?: StartRunOptions) => void
  cancel: (requestId: string) => void
} {
  const queryClient = useQueryClient()
  const { startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, appendToolSubEvent, addInputRequest, resolveInputRequest, dropInputRequestsFor, finishStreaming, clearStreamingBlocks, stopStreaming, setPendingUserMessage } =
    useChatStore()
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const forceRefreshAgentStatus = useForceRefreshAgentStatus()
  const rereadAgentStatus = useRereadAgentStatus()

  // One handler for both send paths: an LLM chat and an agent chat post the
  // same vocabulary, so a case cannot exist on one path and silently not on
  // the other.
  const handleRun = useCallback(
    (chatId: string, event: RunEvent): void => {
      switch (event.type) {
        case 'request-id':
          startStreaming(event.requestId)
          break
        case 'status':
          // Task bookkeeping only. A `needs_input` state is followed by its own
          // `needs_input` event, which is what the store records.
          break
        case 'delta':
          // An LLM's delta is `kind: 'text'` with every other field unset,
          // which lands exactly where a bare text append would.
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
          // Tool-call completion event: pairs a tool-use id with its result.
          // Distinct from the `tool_result` *content kind* handled by `delta`
          // (which streams stdout/stderr text chunks).
          resolveToolCall(event.id, event.result)
          // The nested agent behind this call has finished, and any ask it
          // parked went with it.
          dropInputRequestsFor(event.id)
          break
        case 'tool_error':
          failToolCall(event.id, event.error)
          dropInputRequestsFor(event.id)
          break
        case 'needs_input':
          addInputRequest({ requestId: event.requestId, request: event.request, resume: event.resume })
          break
        case 'input_resolved':
          resolveInputRequest(event.requestId)
          break
        case 'child': {
          // One event from a nested agent (an agent-backed tool call). Its asks
          // are recorded in the chat's list, tagged with the tool call that
          // raised them, and the registry would answer them by id like any
          // other — but no sub-thread renders a control for one yet, so today a
          // nested ask still ends at its park timeout. The call's own
          // `tool_result` / `tool_error` drops them. Everything else
          // accumulates into that tool's live sub-thread.
          const inner = event.event
          if (inner.type === 'needs_input') {
            addInputRequest({
              requestId: inner.requestId,
              request: inner.request,
              resume: inner.resume,
              toolCallId: event.toolCallId
            })
          } else if (inner.type === 'input_resolved') {
            resolveInputRequest(inner.requestId)
          } else if (inner.type !== 'child') {
            // A `child` inside a `child` is dropped: the sub-thread renders one
            // level of hierarchy, and nothing sends deeper.
            appendToolSubEvent(event.toolCallId, inner)
          }
          break
        }
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
          // calls `messageRepo.saveError`; agent turns go through `agent_a2a.ipc`
          // / `a2aStreamingService`, with the typed `code` for the reauth chip)
          // and will render as a `SystemMessage` bubble once `['chat', chatId]`
          // refetches. Don't also call `setSendError` here — it would duplicate
          // the same text as a transient banner above the composer and strip
          // the inline action button.
          console.error('Stream error:', event.error)
          stopStreaming()
          queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
          break
      }
    },
    [startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, appendToolSubEvent, addInputRequest, resolveInputRequest, dropInputRequestsFor, finishStreaming, clearStreamingBlocks, stopStreaming, setPendingUserMessage, queryClient]
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

  const startRun = useCallback(
    (chatId: string, content: string, opts?: StartRunOptions): void => {
      // Null for a turn the local model answers — the per-agent bookkeeping
      // below is skipped, which is what it always did for an LLM chat.
      const agentId = opts?.target?.kind === 'agent' ? opts.target.agentId : null
      setPendingUserMessage({
        content,
        baselineUserCount: snapshotUserCount(chatId),
        attachments: opts?.attachments
      })
      try {
        window.api.run.send(
          chatId,
          content,
          (event) => {
            handleRun(chatId, event)
            if (!agentId) return
            // When the agent finishes (or errors out), it may have updated its
            // STATUS.md during the turn — pull a fresh snapshot so tiles in the
            // status overlay / title-bar dot stay in sync.
            //
            // A folder agent takes the *cheap* path deliberately. A force
            // refresh runs its `status_refresh_command` under the agent's turn
            // lock, so doing it after every message would run the agent's own
            // health check nobody asked for and hold the lock the user's next
            // message needs — a background refresh refusing a message the user
            // just sent. An agent that updates its own STATUS.md does so
            // *during* the turn, so what is needed here is a re-read of the
            // file, which takes no lock and spawns nothing. Running the command
            // stays where a user asked for it: the overlay's Refresh buttons.
            //
            // Remote is unchanged: `force_refresh=true`, backend rate-limited
            // 1/30s per env, 429 swallowed upstream, cinna accounts only.
            if (event.type === 'done' || event.type === 'error') {
              if (isFolderAgentId(agentId)) rereadAgentStatus.mutate(agentId)
              else if (isCinnaUser) forceRefreshAgentStatus.mutate(agentId)
            }
            // A failed turn is the first sign that an agent the composer
            // thought ready is not — ask its driver again, so the next send is
            // refused with the reason instead of failing the same way. A
            // change arrives as a readiness push, which re-reads the list.
            // Fire-and-forget: a re-check that cannot run leaves the last
            // answer where it was.
            if (event.type === 'error') {
              try {
                void window.api.agents.checkReadiness(agentId).catch(() => undefined)
              } catch {
                // Nothing to undo — see above.
              }
            }
          },
          { attachments: opts?.attachments, addressedAgentId: agentId }
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
    [
      handleRun,
      queryClient,
      setPendingUserMessage,
      snapshotUserCount,
      stopStreaming,
      isCinnaUser,
      forceRefreshAgentStatus,
      rereadAgentStatus
    ]
  )

  const cancel = useCallback((requestId: string): void => {
    window.api.run.cancel(requestId)
  }, [])

  return { startRun, cancel }
}
