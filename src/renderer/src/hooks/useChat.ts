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
      updates: { title?: string; modelId?: string; providerId?: string; agentId?: string | null; modeId?: string | null; orchestrated?: boolean }
    }) => window.api.chat.update(chatId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chats'] })
    }
  })
}

/**
 * Promote a chat to orchestrated mode (local model conducts agents-as-tools).
 * Used by the in-chat `@`-agent gesture when adding a second counterparty to a
 * direct-A2A or plain LLM chat. Invalidates the chat detail (root agent detach
 * + orchestrated flag), its on-demand agent set (former root re-added as a
 * tool), and the chat list (model/title surfaces).
 */
export function usePromoteToOrchestrated() {
  const queryClient = useQueryClient()
  type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>
  return useMutation({
    mutationFn: (chatId: string) => window.api.chat.promoteToOrchestrated(chatId),
    // Optimistically flip the cached chat to orchestrated (and detach the root
    // agent) before the round-trip resolves. Without this, picking an agent
    // then immediately pressing Enter races the refetch — `composer.submit`
    // would read the pre-promotion snapshot and route the send to the old root
    // agent over direct A2A instead of the orchestrator.
    onMutate: async (chatId) => {
      await queryClient.cancelQueries({ queryKey: ['chat', chatId] })
      const prev = queryClient.getQueryData<CachedChat>(['chat', chatId])
      if (prev) {
        queryClient.setQueryData<CachedChat>(['chat', chatId], {
          ...prev,
          orchestrated: true,
          agentId: null
        })
      }
      return { prev }
    },
    onError: (_err, chatId, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['chat', chatId], ctx.prev)
    },
    onSettled: (_data, _err, chatId) => {
      queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      queryClient.invalidateQueries({ queryKey: ['chat-on-demand-agent', chatId] })
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
