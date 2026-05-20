import { useQuery } from '@tanstack/react-query'

export interface ModelCapability {
  acceptedMimeTypes: string[]
  maxFileSizeBytes: number
  maxFilesPerMessage: number
}

const EMPTY: ModelCapability = {
  acceptedMimeTypes: [],
  maxFileSizeBytes: 0,
  maxFilesPerMessage: 0
}

/**
 * Resolve what file types the (provider, model) pair accepts. Used by the
 * composer to gate the attach button and by the file picker to filter by
 * accepted MIME types. Returns the empty capability while loading or when
 * either id is missing, so the UI defaults to "no attachments" rather than
 * flashing a button that then disappears.
 */
export function useModelCapability(
  providerId: string | null | undefined,
  modelId: string | null | undefined
): ModelCapability {
  const { data } = useQuery({
    queryKey: ['model-capability', providerId, modelId],
    queryFn: () =>
      providerId && modelId
        ? window.api.llm.getModelCapability({ providerId, modelId })
        : Promise.resolve(EMPTY),
    enabled: !!providerId && !!modelId,
    staleTime: 5 * 60 * 1000
  })
  return data ?? EMPTY
}
