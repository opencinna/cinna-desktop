import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createLogger } from '../stores/logger.store'

const onDemandLog = createLogger('on-demand-mcp')

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

export function useMcpRegistrySearchAll(query: string) {
  return useQuery({
    queryKey: ['mcp-registry-search-all', query.trim()],
    queryFn: () => window.api.mcp.registrySearchAll({ query, limit: 50 }),
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

/**
 * On-demand MCPs the user has `@-mentioned` into the current chat. Lives in
 * its own cache key because it has a different lifecycle from the chat-mode
 * baseline set tracked by [[useChatMcpProviders]].
 */
export function useChatOnDemandMcps(chatId: string | null) {
  return useQuery({
    queryKey: ['chat-on-demand-mcp', chatId],
    queryFn: () =>
      chatId ? window.api.chat.listOnDemandMcps(chatId) : Promise.resolve([]),
    enabled: !!chatId
  })
}

export function useAddOnDemandMcp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      chatId,
      mcpProviderId
    }: {
      chatId: string
      mcpProviderId: string
    }) => window.api.chat.addOnDemandMcp(chatId, mcpProviderId),
    onSuccess: (_data, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chat-on-demand-mcp', chatId] })
    },
    // No toast system yet — at least surface the failure in the in-app
    // logger so the user can ⌘` it and see why a chip never appeared.
    onError: (error, { chatId, mcpProviderId }) => {
      onDemandLog.error('add failed', {
        chatId,
        mcpProviderId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

export function useRemoveOnDemandMcp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      chatId,
      mcpProviderId
    }: {
      chatId: string
      mcpProviderId: string
    }) => window.api.chat.removeOnDemandMcp(chatId, mcpProviderId),
    onSuccess: (_data, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chat-on-demand-mcp', chatId] })
    },
    onError: (error, { chatId, mcpProviderId }) => {
      onDemandLog.error('remove failed', {
        chatId,
        mcpProviderId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
