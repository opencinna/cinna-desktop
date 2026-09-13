import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatDetail, useChatList } from './useChat'
import { useAuthStore } from '../stores/auth.store'

/** MainArea passes a chat ID only while its conversation is visible. */
export function useReadChatResult(visibleChatId: string | null): void {
  const [foreground, setForeground] = useState(() => document.hasFocus() && document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setForeground(document.hasFocus() && document.visibilityState !== 'hidden')
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  const { data: chats } = useChatList()
  const detail = useChatDetail(visibleChatId)
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.currentUser?.id)
  const chat = chats?.find((item) => item.id === visibleChatId)
  const result = !chat?.activeRunId ? chat?.lastRunResult : null
  // The same query renders the transcript. A selected row or a successful
  // list refresh alone is not evidence that its new result has appeared.
  const unreadRunId = result?.unread && detail.isSuccess &&
    detail.data?.lastRunResult?.runId === result.runId ? result.runId : null
  useEffect(() => {
    if (!foreground || !visibleChatId || !unreadRunId) return
    void window.api.chat.markResultRead(visibleChatId, unreadRunId).then(() => {
      if (useAuthStore.getState().currentUser?.id !== userId) return
      void queryClient.cancelQueries({ queryKey: ['chats'], exact: true })
      queryClient.setQueryData<Awaited<ReturnType<typeof window.api.chat.list>>>(['chats'], (items) =>
        items?.map((item) => item.id === visibleChatId && item.lastRunResult?.runId === unreadRunId
          ? { ...item, lastRunResult: { ...item.lastRunResult, unread: false } } : item))
    }).catch(() => { /* Leave it unread so opening the chat again retries. */ })
  }, [foreground, visibleChatId, unreadRunId, queryClient, userId])
}
