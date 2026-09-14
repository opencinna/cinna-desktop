import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import { unwrapIpcError } from '../utils/ipcError'

// Cached `['chat', chatId]` shape — used to snapshot the persisted user-message
// count at send time so the optimistic bubble retires the instant a new user
// row lands (see `pendingUserMessage` / `PendingUserMessage`).
type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
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
   * Who the caller believes will answer, from routingOf(chat). Main resolves
   * routing again; this only supplies the addressed agent in a human chat.
   * The live watcher uses main's resolved agentId for status/readiness updates.
   */
  target?: RunTarget
}

/** Apply the shared event vocabulary to the selected chat's projection. */
export function useRunEventHandler(): (chatId: string, event: RunEvent) => void {
  const { startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, appendToolSubEvent, appendUserMessage, addInputRequest, resolveInputRequest, dropInputRequestsFor, finishStreaming } = useChatStore()
  // One handler for both send paths: an LLM chat and an agent chat post the
  // same vocabulary, so a case cannot exist on one path and silently not on
  // the other.
  const handleRun = useCallback(
    (chatId: string, event: RunEvent): void => {
      if (useChatStore.getState().activeChatId !== chatId) return
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
        case 'user_message':
          // Sent while the turn ran and taken into it: shown where it landed.
          appendUserMessage(event.text)
          break
        case 'done':
        case 'error':
          if (event.type === 'error') console.error('Stream error:', event.error)
          finishStreaming()
          break
      }
    },
    [startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, appendToolSubEvent, appendUserMessage, addInputRequest, resolveInputRequest, dropInputRequestsFor, finishStreaming]
  )

  return handleRun
}

/** Sending is a command; the selected chat's watcher owns all streamed output. */
export function useChatStream(): {
  startRun: (chatId: string, content: string, opts?: StartRunOptions) => void
  cancel: (requestId: string) => void
} {
  const queryClient = useQueryClient()
  const startRun = useCallback((chatId: string, content: string, opts?: StartRunOptions): void => {
    const state = useChatStore.getState()
    const cached = queryClient.getQueryData<CachedChat>(['chat', chatId])
    // With a turn running, main takes the message into it or queues it. The
    // optimistic bubble renders above the live turn and retires by user-row
    // count, so it would sit in the wrong place until that turn ended: the
    // `user_message` event or the queue shows the message instead.
    const running = !!cached?.activeRunId || (state.activeChatId === chatId && state.isStreaming)
    // Measured at send time either way: a bubble shown later must still retire
    // on this message's own row, not on one that landed in between.
    const baselineUserCount = cached?.messages?.filter((m) => m.role === 'user').length ?? 0
    const pending = running ? null : { content, baselineUserCount, attachments: opts?.attachments }
    if (state.activeChatId === chatId) {
      state.noteSent()
      if (pending) state.setPendingUserMessage(pending)
    }
    void window.api.run.start({ chatId, content, attachments: opts?.attachments,
      addressedAgentId: opts?.target?.kind === 'agent' ? opts.target.agentId : null
    }).then((result) => {
      const current = useChatStore.getState()
      if (result.kind === 'started') {
        // This view believed a turn was running, and it had already ended: the
        // message started a turn of its own. Show it the way an idle send does.
        if (!pending && current.activeChatId === chatId && !current.pendingUserMessage) {
          current.setPendingUserMessage({ content, baselineUserCount, attachments: opts?.attachments })
        }
        return
      }
      // Main found a turn running that this view had not seen yet.
      if (pending && current.pendingUserMessage === pending) current.setPendingUserMessage(null)
      if (result.kind === 'queued') void queryClient.invalidateQueries({ queryKey: ['run-queue', chatId] })
      // The engine took it after the turn's rows were built, so main saved it
      // on its own: nothing else will show it, or move the chat up the list.
      else if (result.saved) {
        void queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
        void queryClient.invalidateQueries({ queryKey: ['chats'] })
      }
    }, (error) => {
      const current = useChatStore.getState()
      if (current.activeChatId !== chatId) return
      if (pending) {
        if (current.pendingUserMessage !== pending) return
        current.setPendingUserMessage(null)
      }
      current.setSendError(unwrapIpcError(error, 'This turn could not be started.'))
    })
  }, [queryClient])
  const cancel = useCallback((requestId: string): void => { window.api.run.cancel(requestId) }, [])
  return { startRun, cancel }
}
