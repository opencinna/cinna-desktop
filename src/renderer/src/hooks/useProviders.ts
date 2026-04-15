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
    mutationFn: (data: { type: string; apiKey: string }) => {
      const api = getApi()
      if (typeof api.providers.testKey === 'function') {
        return api.providers.testKey(data)
      }
      // Fallback: save temporarily, test, then delete if no prior provider
      return Promise.resolve({
        success: false as const,
        error: 'Restart the app to enable key validation'
      })
    }
  })
}
