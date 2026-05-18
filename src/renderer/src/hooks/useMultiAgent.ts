import { useMutation, useQueryClient } from '@tanstack/react-query'

export function useRewriteMessage() {
  return useMutation({
    mutationFn: (data: { chatId: string; targetAgentId: string; userText: string }) =>
      window.api.multiAgent.rewrite(data)
  })
}

type CachedChat = Awaited<ReturnType<typeof window.api.chat.get>>

export function useSetActiveAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { chatId: string; agentId: string | null }) =>
      window.api.multiAgent.setActiveAgent(data),
    // Optimistic update: flip `activeAgentId` in the cached chat *before* the
    // round-trip resolves. Without this, popup-select → quick-Enter races the
    // refetch — `inChatMention.activeAgent` stays stale, `handleSend` routes
    // to the old target, and Smart Rewrite is skipped on the new agent's
    // join moment.
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['chat', vars.chatId] })
      const prev = queryClient.getQueryData<CachedChat>(['chat', vars.chatId])
      if (prev) {
        queryClient.setQueryData<CachedChat>(['chat', vars.chatId], {
          ...prev,
          activeAgentId: vars.agentId
        })
      }
      return { prev }
    },
    onError: (_err, vars, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(['chat', vars.chatId], ctx.prev)
      }
    },
    onSettled: (_data, _err, vars) => {
      queryClient.invalidateQueries({ queryKey: ['chat', vars.chatId] })
      queryClient.invalidateQueries({ queryKey: ['chats'] })
    }
  })
}

export function useDisableSmartAssist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (chatId: string) =>
      window.api.multiAgent.disableSmartAssist({ chatId }),
    onSuccess: (_data, chatId) => {
      queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
    }
  })
}

export function useBuildCatchup() {
  return useMutation({
    mutationFn: (data: { chatId: string; targetAgentId: string }) =>
      window.api.multiAgent.buildCatchup(data)
  })
}
