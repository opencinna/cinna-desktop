import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import { useCallback } from 'react'

export function useChatList() {
  return useQuery({
    queryKey: ['chats'],
    queryFn: () => window.api.chat.list()
  })
}

export function useChatDetail(chatId: string | null) {
  return useQuery({
    queryKey: ['chat', chatId],
    queryFn: () => (chatId ? window.api.chat.get(chatId) : null),
    enabled: !!chatId
  })
}

export function useCreateChat() {
  const queryClient = useQueryClient()
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)

  return useMutation({
    mutationFn: () => window.api.chat.create(),
    onSuccess: (chat) => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      setActiveChatId(chat.id)
    }
  })
}

export function useDeleteChat() {
  const queryClient = useQueryClient()
  const { activeChatId, setActiveChatId } = useChatStore()

  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.delete(chatId),
    onSuccess: (_data, chatId) => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['trash'] })
      if (activeChatId === chatId) {
        setActiveChatId(null)
      }
    }
  })
}

export function useTrashList() {
  return useQuery({
    queryKey: ['trash'],
    queryFn: () => window.api.chat.trashList()
  })
}

export function useRestoreChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.restore(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['trash'] })
    }
  })
}

export function usePermanentDeleteChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.permanentDelete(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] })
    }
  })
}

export function useEmptyTrash() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.chat.emptyTrash(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] })
    }
  })
}

export function useUpdateChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      chatId,
      updates
    }: {
      chatId: string
      updates: { title?: string; modelId?: string; providerId?: string }
    }) => window.api.chat.update(chatId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
    }
  })
}

export function useSendMessage() {
  const queryClient = useQueryClient()
  const { activeChatId, startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, stopStreaming } =
    useChatStore()

  const send = useCallback(
    (content: string) => {
      if (!activeChatId) return

      const chatId = activeChatId
      window.api.llm.sendMessage(chatId, content, (event) => {
        switch (event.type) {
          case 'request-id':
            startStreaming(event.requestId!)
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
            stopStreaming()
            queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
            queryClient.invalidateQueries({ queryKey: ['chats'] })
            break
          case 'error':
            console.error('LLM error:', event.error)
            useChatStore.getState().stopStreaming()
            queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
            break
        }
      })

      // Refetch chat detail shortly after so the user message bubble appears
      // (main process saves the user message to DB before streaming starts)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      }, 300)
    },
    [activeChatId, startStreaming, appendDelta, addToolCall, resolveToolCall, failToolCall, stopStreaming, queryClient]
  )

  return send
}
