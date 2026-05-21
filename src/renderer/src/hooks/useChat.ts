import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import { useCallback, useEffect } from 'react'
import { useChatStream } from './useChatStream'

export function useChatList() {
  const queryClient = useQueryClient()

  // Subscribe to main-process background chat-title autogen completions so
  // the sidebar and the active chat header pick up the new title instantly,
  // without waiting for the next manual refetch.
  useEffect(() => {
    return window.api.chat.onTitleUpdated(({ chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
    })
  }, [queryClient])

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

/**
 * Promote a hidden (job-spawned) chat into the main Chats sidebar list.
 * Invalidates `['chats']` so the chat appears immediately, and `['jobs']` so
 * any run row showing the "Move to Chats" button updates to reflect the new
 * `chatHidden = false` state.
 */
export function useShowChatInList() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.showInList(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    }
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
      updates: { title?: string; modelId?: string; providerId?: string; agentId?: string; modeId?: string | null }
    }) => window.api.chat.update(chatId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
    }
  })
}

export function useSendMessage() {
  const activeChatId = useChatStore((s) => s.activeChatId)
  const { startLlm, startAgent } = useChatStream()

  return useCallback(
    async (content: string) => {
      if (!activeChatId) return
      const chatId = activeChatId

      const session = await window.api.agents.getSession(chatId)
      if (session) {
        startAgent(session.agentId, chatId, content)
        return
      }
      startLlm(chatId, content)
    },
    [activeChatId, startAgent, startLlm]
  )
}
