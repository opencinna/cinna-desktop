import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

function getApi() {
  if (!window.api) {
    throw new Error('App not ready — please restart the application')
  }
  return window.api
}

export function useProviders() {
  const queryClient = useQueryClient()

  // Account-config sync (managed providers materialized/refreshed in the main
  // process) broadcasts on completion — refetch so managed providers surface
  // without a manual reload. Mirrors `useAgents` + `onRemoteSyncComplete`.
  useEffect(() => {
    return getApi().providers.onAccountConfigSynced(() => {
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    })
  }, [queryClient])

  return useQuery({
    queryKey: ['providers'],
    queryFn: () => getApi().providers.list()
  })
}

/**
 * Trigger a manual account-config sync (re-fetch managed providers/modes from
 * cinna-core). The main process broadcasts `providers:account-config-synced` on
 * completion, which `useProviders`/`useChatModes` already listen for — so no
 * explicit invalidation here; this hook just exposes the call + `isPending`.
 */
export function useSyncAccountConfig() {
  return useMutation({
    mutationFn: () => getApi().providers.syncAccountConfig()
  })
}

export function useUpsertProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      id?: string
      type: string
      name: string
      apiKey?: string
      enabled?: boolean
      defaultModelId?: string | null
    }) => getApi().providers.upsert(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    }
  })
}

export function useDeleteProvider() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (providerId: string) => getApi().providers.delete(providerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    }
  })
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (providerId: string) => getApi().providers.test(providerId)
  })
}

export function useTestProviderKey() {
  return useMutation({
    mutationFn: (data: { type: string; apiKey: string }) => getApi().providers.testKey(data)
  })
}
