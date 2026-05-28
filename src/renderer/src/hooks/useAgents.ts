import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createLogger } from '../stores/logger.store'

const onDemandLog = createLogger('on-demand-agent')

export type RemoteSyncStatus = { error?: 'reauth_required' | 'sync_failed' }

export const REMOTE_SYNC_STATUS_KEY = ['agents', 'remote-sync-status'] as const

export function useAgents() {
  const queryClient = useQueryClient()

  // Invalidate agents query when main process completes a remote sync, and
  // mirror any error code into the shared sync-status cache so the UI can
  // surface a re-auth banner without threading state through props.
  useEffect(() => {
    return window.api.agents.onRemoteSyncComplete((payload) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.setQueryData<RemoteSyncStatus>(REMOTE_SYNC_STATUS_KEY, {
        error: payload.error
      })
    })
  }, [queryClient])

  return useQuery({
    queryKey: ['agents'],
    queryFn: () => window.api.agents.list()
  })
}

export function useRemoteSyncStatus(): RemoteSyncStatus {
  return (
    useQuery<RemoteSyncStatus>({
      queryKey: REMOTE_SYNC_STATUS_KEY,
      queryFn: () => ({}),
      staleTime: Infinity
    }).data ?? {}
  )
}

export function useUpsertAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      id?: string
      name: string
      description?: string
      protocol: string
      cardUrl?: string
      endpointUrl?: string
      protocolInterfaceUrl?: string
      protocolInterfaceVersion?: string
      accessToken?: string
      cardData?: Record<string, unknown>
      skills?: Array<{ id: string; name: string; description?: string }>
      enabled?: boolean
    }) => window.api.agents.upsert(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

type AgentRow = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export function useSetAgentEnabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ agentId, enabled }: { agentId: string; enabled: boolean }) => {
      const res = await window.api.agents.setEnabled(agentId, enabled)
      if (!res.success) throw new Error(res.error ?? 'Failed to update agent')
      return res
    },
    // Optimistically flip the cached agent so the toggle moves immediately;
    // roll back if the IPC fails.
    onMutate: async ({ agentId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['agents'] })
      const previous = queryClient.getQueryData<AgentRow[]>(['agents'])
      if (previous) {
        queryClient.setQueryData<AgentRow[]>(
          ['agents'],
          previous.map((a) => (a.id === agentId ? { ...a, enabled } : a))
        )
      }
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['agents'], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

export function useDeleteAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) => window.api.agents.delete(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

export function useFetchAgentCard() {
  return useMutation({
    mutationFn: (data: { cardUrl: string; accessToken?: string }) =>
      window.api.agents.fetchCard(data)
  })
}

export function useTestAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) => window.api.agents.test(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

/**
 * On-demand agents the user has `@-mentioned` into the current chat — the
 * orchestrated-mode tool set. Mirrors [[useChatOnDemandMcps]]; lives in its
 * own cache key because its lifecycle differs from the bound/active agent.
 */
export function useChatOnDemandAgents(chatId: string | null) {
  return useQuery({
    queryKey: ['chat-on-demand-agent', chatId],
    queryFn: () =>
      chatId ? window.api.chat.listOnDemandAgents(chatId) : Promise.resolve([]),
    enabled: !!chatId
  })
}

export function useAddOnDemandAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ chatId, agentId }: { chatId: string; agentId: string }) =>
      window.api.chat.addOnDemandAgent(chatId, agentId),
    onSuccess: (_data, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chat-on-demand-agent', chatId] })
    },
    onError: (error, { chatId, agentId }) => {
      onDemandLog.error('add failed', {
        chatId,
        agentId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

export function useRemoveOnDemandAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ chatId, agentId }: { chatId: string; agentId: string }) =>
      window.api.chat.removeOnDemandAgent(chatId, agentId),
    onSuccess: (_data, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: ['chat-on-demand-agent', chatId] })
    },
    onError: (error, { chatId, agentId }) => {
      onDemandLog.error('remove failed', {
        chatId,
        agentId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

export function useSyncRemoteAgents() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.agents.syncRemote(),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      if (result.success) {
        queryClient.setQueryData<RemoteSyncStatus>(REMOTE_SYNC_STATUS_KEY, {})
        return
      }
      const error =
        result.code === 'reauth_required' ? 'reauth_required' : 'sync_failed'
      queryClient.setQueryData<RemoteSyncStatus>(REMOTE_SYNC_STATUS_KEY, { error })
    }
  })
}
