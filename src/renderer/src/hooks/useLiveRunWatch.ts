import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { RunWatchMessage } from '../../../shared/runWatch'
import { useChatStore } from '../stores/chat.store'
import { useAuthStore } from '../stores/auth.store'
import { useRunEventHandler } from './useChatStream'
import { useAfterTurnAgentStatus } from './useAgentStatus'

/** The longest a next turn waits on the ended turn's saved read before it shows anyway. */
export const HELD_RUN_MAX_MS = 2000

/** Mounted once by MainArea. Switching views only changes the subscription. */
export function useLiveRunWatch(): void {
  const chatId = useChatStore((state) => state.activeChatId)
  const userId = useAuthStore((state) => state.currentUser?.id)
  const handleRun = useRunEventHandler()
  const queryClient = useQueryClient()
  const { mutate: refreshStatus } = useAfterTurnAgentStatus()
  useEffect(() => {
    if (!chatId || !userId) return
    let disposed = false
    let runId: string | null = null
    let sequence = -1
    let replayAvailable = true
    let needsSettlement = false
    let settling = false
    // A run that started while the ended run's saved read was in flight, and
    // every message after it, in arrival order. See the snapshot branch below.
    let held: RunWatchMessage[] | null = null
    let heldTimer: ReturnType<typeof setTimeout> | undefined
    // True while the held messages replay: their snapshot is applied now, even
    // though the read it waited on may still be in flight.
    let releasing = false
    const release = (): void => {
      clearTimeout(heldTimer)
      heldTimer = undefined
      const waiting = held
      held = null
      if (!waiting) return
      releasing = true
      try { waiting.forEach(receive) } finally { releasing = false }
    }
    const current = (): boolean => !disposed && useChatStore.getState().activeChatId === chatId && useAuthStore.getState().currentUser?.id === userId
    const settle = async (): Promise<void> => {
      if (settling || !needsSettlement || !current()) return
      settling = true
      const version = useChatStore.getState().liveProjectionVersion
      const pending = useChatStore.getState().pendingUserMessage
      try {
        // Cancel any read started before the ending, then demand a fresh saved
        // transcript. A later successful read retries this path after a failure.
        await queryClient.cancelQueries({ queryKey: ['chat', chatId], exact: true })
        await queryClient.fetchQuery({ queryKey: ['chat', chatId], queryFn: () => window.api.chat.get(chatId), staleTime: 0 })
        const state = useChatStore.getState()
        if (!current() || state.liveProjectionVersion !== version || state.pendingUserMessage !== pending) return
        needsSettlement = false
        state.clearStreamingBlocks()
        state.setPendingUserMessage(null)
        useChatStore.setState({ liveBaselineMessageIds: null })
      } catch { /* Keep the projection until a fresh read succeeds. */ }
      finally {
        settling = false
        // The held run goes in now whatever the read did. After a success the
        // saved rows are in the cache; after a failure nothing would retry the
        // read on the held run's behalf, so it replaces the projection as it
        // would have on arrival.
        release()
        if (current() && needsSettlement && useChatStore.getState().liveProjectionVersion !== version) void settle()
      }
    }
    const stopReading = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success' && event.query.queryKey[0] === 'chat' && event.query.queryKey[1] === chatId) void settle()
    })
    const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['chat', chatId] }) }
    const receive = (message: RunWatchMessage): void => {
      if (!current()) return
      if (held) {
        held.push(message)
        return
      }
      if (message.type === 'snapshot') {
        if (message.active) {
          // Persist activity outside the selected transcript before switching
          // chats can clear isStreaming. Cancel older list reads so an idle
          // response cannot overwrite this newer run-start notification.
          void queryClient.cancelQueries({ queryKey: ['chats'], exact: true })
          queryClient.setQueryData<Awaited<ReturnType<typeof window.api.chat.list>>>(['chats'], (chats) =>
            chats?.map((chat) => chat.id === chatId ? { ...chat, activeRunId: message.runId } : chat))
        }
        // A run starting while the ended one's saved transcript is still being
        // read — a queued message drained the moment that turn ended — would
        // reset the projection a round trip before those saved rows reach the
        // cache: the ended turn's output vanished and the transcript shrank to
        // the top of the chat for a few frames (ux_rules §1). Hold the new run
        // until that read ends. `settle` clears the old projection and replays
        // these messages in the same task, so the saved rows and the new run
        // render together. Nothing stale can outlive it: the held snapshot is
        // applied exactly once, and applying a snapshot always resets the blocks.
        //
        // For at most HELD_RUN_MAX_MS, though: a slow read, or a refetch that
        // replaced it mid-flight, must not keep the next turn off screen. The
        // read carries on. When it lands late, `settle` finds the projection
        // version bumped by the snapshot released here, skips the clear, and
        // leaves the new run alone.
        if (message.active && needsSettlement && settling && !releasing) {
          held = [message]
          heldTimer = setTimeout(release, HELD_RUN_MAX_MS)
          return
        }
        runId = message.runId
        sequence = message.sequence
        replayAvailable = message.replayAvailable
        needsSettlement = !message.active
        useChatStore.setState({ liveRunId: runId,
          liveProjectionVersion: useChatStore.getState().liveProjectionVersion + 1,
          liveBaselineMessageIds: message.active && replayAvailable ? message.baselineMessageIds : null,
          streamingBlocks: [], activeRequestId: null, isStreaming: message.active && replayAvailable,
          inputRequests: [], settledInputRequestIds: [] })
        if (replayAvailable) for (const event of message.events) handleRun(chatId, event)
        if (message.active) refresh()
        else void settle()
        return
      }
      if (message.type === 'watch_error') {
        replayAvailable = false
        useChatStore.setState({ isStreaming: false, liveBaselineMessageIds: null, streamingBlocks: [],
          sendError: 'Live updates were interrupted. Showing saved messages while the task continues.' })
        refresh()
        return
      }
      if (message.runId !== runId || message.sequence <= sequence) return
      sequence = message.sequence
      if (message.type === 'accepted') { refresh(); return }
      if (message.type === 'closed') {
        handleRun(chatId, { type: 'done' })
        needsSettlement = true
        void settle()
        void queryClient.invalidateQueries({ queryKey: ['chats'] })
        void queryClient.invalidateQueries({ queryKey: ['jobs'] })
        return
      }
      if (message.type !== 'event') return
      if (replayAvailable) handleRun(chatId, message.event)
      if (message.event.type === 'done' || message.event.type === 'error') {
        const agentId = message.agentId
        if (agentId) {
          refreshStatus(agentId)
          if (message.event.type === 'error') void window.api.agents.checkReadiness(agentId).catch(() => {})
        }
      }
    }
    const unwatch = window.api.run.watch(chatId, receive)
    return () => { disposed = true; clearTimeout(heldTimer); stopReading(); unwatch() }
  }, [chatId, userId, handleRun, queryClient, refreshStatus])
}
