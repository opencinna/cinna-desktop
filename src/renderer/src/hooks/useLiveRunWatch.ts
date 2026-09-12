import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import { useAuthStore } from '../stores/auth.store'
import { useRunEventHandler } from './useChatStream'
import { useAfterTurnAgentStatus } from './useAgentStatus'

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
        if (current() && needsSettlement && useChatStore.getState().liveProjectionVersion !== version) void settle()
      }
    }
    const stopReading = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success' && event.query.queryKey[0] === 'chat' && event.query.queryKey[1] === chatId) void settle()
    })
    const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['chat', chatId] }) }
    const unwatch = window.api.run.watch(chatId, (message) => {
      if (!current()) return
      if (message.type === 'snapshot') {
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
    })
    return () => { disposed = true; stopReading(); unwatch() }
  }, [chatId, userId, handleRun, queryClient, refreshStatus])
}
