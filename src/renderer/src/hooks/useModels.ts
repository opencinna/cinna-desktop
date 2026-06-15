import { useQuery } from '@tanstack/react-query'

export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: () => window.api.providers.listModels()
  })
}

/**
 * On-demand live model fetch for a single provider (scope-aware → managed
 * providers too). Used as a fallback when the aggregate `useModels()` registry
 * has no models for a credential — pulls the list straight from the provider API
 * using the stored key. Only runs while `enabled` (e.g. a card is expanded).
 */
export function useProviderModels(providerId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['provider-models', providerId],
    queryFn: () => window.api.providers.fetchModels(providerId as string),
    enabled: enabled && !!providerId,
    staleTime: 5 * 60 * 1000,
    retry: false
  })
}
