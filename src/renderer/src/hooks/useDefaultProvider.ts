import { useProviders } from './useProviders'

export function useDefaultProviderId(): string | null {
  const { data: providers } = useProviders()
  if (!providers) return null
  const enabled = providers.filter((p) => p.enabled && p.hasApiKey)
  const def = enabled.find((p) => p.isDefault)
  return def?.id ?? enabled[0]?.id ?? null
}
