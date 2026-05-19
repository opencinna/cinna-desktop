import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export function useMcpProviders() {
  return useQuery({
    queryKey: ['mcp-providers'],
    queryFn: () => window.api.mcp.list(),
    refetchInterval: (query) => {
      // Poll while any provider is awaiting auth
      const data = query.state.data
      if (data?.some((p) => p.status === 'awaiting-auth')) {
        return 2000
      }
      return false
    }
  })
}

export function useUpsertMcpProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      id?: string
      name: string
      transportType: string
      command?: string
      args?: string[]
      url?: string
      env?: Record<string, string>
      enabled?: boolean
    }) => window.api.mcp.upsert(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-providers'] })
    }
  })
}

export function useDeleteMcpProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (providerId: string) => window.api.mcp.delete(providerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-providers'] })
    }
  })
}

export function useConnectMcp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (providerId: string) => window.api.mcp.connect(providerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-providers'] })
    }
  })
}

export function useDisconnectMcp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (providerId: string) => window.api.mcp.disconnect(providerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-providers'] })
    }
  })
}

export function useMcpRegistries() {
  return useQuery({
    queryKey: ['mcp-registries'],
    queryFn: () => window.api.mcp.registryList(),
    staleTime: Infinity
  })
}

export function useMcpRegistrySearch(registryId: string | null, query: string) {
  return useQuery({
    queryKey: ['mcp-registry-search', registryId, query.trim()],
    queryFn: () =>
      window.api.mcp.registrySearch({ registryId: registryId!, query, limit: 50 }),
    enabled: !!registryId,
    staleTime: 5 * 60 * 1000
  })
}

export function useChatMcpProviders(chatId: string | null) {
  return useQuery({
    queryKey: ['chat-mcp', chatId],
    queryFn: () =>
      chatId ? window.api.chat.getMcpProviders(chatId) : Promise.resolve([]),
    enabled: !!chatId
  })
}

export function useSetChatMcpProviders() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      chatId,
      mcpProviderIds
    }: {
      chatId: string
      mcpProviderIds: string[]
    }) => window.api.chat.setMcpProviders(chatId, mcpProviderIds),
    onSuccess: (_data, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chat-mcp', chatId] })
    }
  })
}
