import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export function useChatModes() {
  return useQuery({
    queryKey: ['chat-modes'],
    queryFn: () => window.api.chatModes.list()
  })
}

export function useUpsertChatMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      id?: string
      name: string
      providerId?: string | null
      modelId?: string | null
      mcpProviderIds?: string[]
      colorPreset?: string
    }) => window.api.chatModes.upsert(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
    }
  })
}

export function useDeleteChatMode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.api.chatModes.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-modes'] })
    }
  })
}
