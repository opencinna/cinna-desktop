import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatDetail, useChatList } from './useChat'
import { useAuthStore } from '../stores/auth.store'
import { useAppForeground } from './useAppForeground'

type ChatDetail = Awaited<ReturnType<typeof window.api.chat.get>>

/** MainArea passes a chat ID only while its conversation is visible. */
export function useReadChatResult(visibleChatId: string | null): void {
  const foreground = useAppForeground()
  const { data: chats } = useChatList()
  const detail = useChatDetail(visibleChatId)
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.currentUser?.id)
  const chat = chats?.find((item) => item.id === visibleChatId)
  // A job's chat stays out of the list until it is moved to Chats; its result
  // is then read from the transcript query itself, which is the evidence.
  const source = chat ?? (chats && visibleChatId && detail.data?.id === visibleChatId ? detail.data : undefined)
  const result = !source?.activeRunId ? source?.lastRunResult : null
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
      queryClient.setQueryData<ChatDetail>(['chat', visibleChatId], (data) =>
        data?.lastRunResult?.runId === unreadRunId ? { ...data, lastRunResult: { ...data.lastRunResult, unread: false } } : data)
      // A job row shows its latest run's result too.
      void queryClient.invalidateQueries({ queryKey: ['jobs'], exact: true })
    }).catch(() => { /* Leave it unread so opening the chat again retries. */ })
  }, [foreground, visibleChatId, unreadRunId, queryClient, userId])
}
