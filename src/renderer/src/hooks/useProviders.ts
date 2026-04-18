import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

function getApi() {
  if (!window.api) {
    throw new Error('App not ready — please restart the application')
  }
  return window.api
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => getApi().providers.list()
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
      isDefault?: boolean
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
