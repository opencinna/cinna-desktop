import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export function useAgents() {
  const queryClient = useQueryClient()

  // Invalidate agents query when main process completes a remote sync
  useEffect(() => {
    return window.api.agents.onRemoteSyncComplete(() => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    })
  }, [queryClient])

  return useQuery({
    queryKey: ['agents'],
    queryFn: () => window.api.agents.list()
  })
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

export function useSyncRemoteAgents() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.agents.syncRemote(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}
