import { useQuery } from '@tanstack/react-query'

export function useModels() {
  return useQuery({
    queryKey: ['models'],
    queryFn: () => window.api.providers.listModels()
  })
}
