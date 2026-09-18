import { useQuery } from '@tanstack/react-query'
import type { AgentEngine } from '../../../shared/engine'

/** Reading a catalog never launches a runtime; entries come from prior ACP sessions. */
export function useRuntimeModelCatalog(engine: AgentEngine | null | undefined) {
  return useQuery({
    queryKey: ['runtime-model-catalog', engine],
    queryFn: () => window.api.engine.modelCatalog(engine!),
    enabled: engine === 'claude' || engine === 'codex',
    staleTime: 0
  })
}
