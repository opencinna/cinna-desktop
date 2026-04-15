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
