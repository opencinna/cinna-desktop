import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createLogger } from '../stores/logger.store'

const onDemandLog = createLogger('on-demand-mcp')
const baselineLog = createLogger('chat-mcp')
const agentAddonLog = createLogger('agent-mcp')

export function useMcpProviders() {
  const queryClient = useQueryClient()

  // Subscribe to main-process MCP status broadcasts so any UI consuming the
  // provider list (Settings cards, the `@` picker MCP section, the chips
  // strip) reflects connect/disconnect transitions instantly — without
  // waiting for the auth-pending polling fallback to tick.
  useEffect(() => {
    return window.api.mcp.onStatusChanged(() => {
      queryClient.invalidateQueries({ queryKey: ['mcp-providers'] })
    })
  }, [queryClient])

  return useQuery({
    queryKey: ['mcp-providers'],
    queryFn: () => window.api.mcp.list(),
    refetchInterval: (query) => {
      // Polling fallback for the awaiting-auth state — the main process can't
      // broadcast progress *during* the OAuth dance (no transition events
      // fire until the user clicks through the browser), so we still poll
      // here for the spinner to feel live.
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
      authType?: 'oauth' | 'bearer'
      bearerToken?: string
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
      // The delete cascades to every agent the connector was attached to.
      queryClient.invalidateQueries({ queryKey: ['agent-mcp'] })
      queryClient.invalidateQueries({ queryKey: ['mcp-agents-using'] })
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
    },
    // This write is the *only* thing that sets a chat's baseline: a mode
    // switch replaces it wholesale (an empty mode list clears it). A silent
    // failure therefore leaves the chat out of sync with its mode with no
    // other surface to notice it — log so ⌘` shows why.
    onError: (error, { chatId, mcpProviderIds }) => {
      baselineLog.error('set baseline failed', {
        chatId,
        mcpProviderIds,
        error: error instanceof Error ? error.message : String(error)
      })
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

/**
 * MCP connectors attached to a folder agent as addons (provider ids, oldest
 * first). Also what an agent-bound chat's chips draw as locked. Empty for an
 * agent that is not a folder agent.
 */
export function useAgentMcpProviders(agentId: string | null) {
  return useQuery({
    queryKey: ['agent-mcp', agentId],
    queryFn: () =>
      agentId ? window.api.localAgents.listMcpProviders(agentId) : Promise.resolve([]),
    enabled: !!agentId
  })
}

function useAgentMcpMutation(
  action: 'attach' | 'detach',
  call: (agentId: string, mcpProviderId: string) => Promise<{ success: true }>
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, mcpProviderId }: { agentId: string; mcpProviderId: string }) =>
      call(agentId, mcpProviderId),
    onSuccess: (_data, { agentId, mcpProviderId }) => {
      queryClient.invalidateQueries({ queryKey: ['agent-mcp', agentId] })
      queryClient.invalidateQueries({ queryKey: ['mcp-agents-using', mcpProviderId] })
    },
    onError: (error, { agentId, mcpProviderId }) => {
      agentAddonLog.error(`${action} failed`, {
        agentId,
        mcpProviderId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

export function useAttachAgentMcp() {
  return useAgentMcpMutation('attach', (agentId, mcpProviderId) =>
    window.api.localAgents.attachMcpProvider(agentId, mcpProviderId)
  )
}

export function useDetachAgentMcp() {
  return useAgentMcpMutation('detach', (agentId, mcpProviderId) =>
    window.api.localAgents.detachMcpProvider(agentId, mcpProviderId)
  )
}

/** The folder agents a connector is attached to — named by the delete confirm. */
export function useMcpAgentsUsing(mcpProviderId: string | null) {
  return useQuery({
    queryKey: ['mcp-agents-using', mcpProviderId],
    queryFn: () =>
      mcpProviderId ? window.api.mcp.agentsUsing(mcpProviderId) : Promise.resolve([]),
    enabled: !!mcpProviderId
  })
}
