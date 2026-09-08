import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import type { OllamaDetectionData } from '../../../preload'
import { AGENT_CREDENTIAL_BINDINGS_KEY } from './useLocalAgents'

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
      // A sync materialises and retires managed credentials on a background
      // timer with no IPC call to hook, so it can change which credential an
      // agent resolves to with nothing on screen having been clicked. Without
      // this the sidebar keeps the dot it drew before the sync.
      queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
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
      baseUrl?: string | null
    }) => getApi().providers.upsert(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      // The probe reports whether a host already *has* a credential, which is
      // exactly what this call changes. Without invalidating it, the 15s cache
      // would let the Add form offer a second Ollama for a host that had just
      // been added, and leave the section's offer row on screen after its own
      // button had done its job.
      queryClient.invalidateQueries({ queryKey: ['ollama-detection'] })
      // A credential's on/off switch and its default model both change which
      // credential a folder agent resolves to, so the sidebar's status dot and
      // the "would this stop anything" question behind the switch are stale the
      // moment this returns.
      queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
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
      // Deleting the Ollama credential makes the offer worth showing again.
      queryClient.invalidateQueries({ queryKey: ['ollama-detection'] })
      queryClient.invalidateQueries({ queryKey: AGENT_CREDENTIAL_BINDINGS_KEY })
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
    mutationFn: (data: { type: string; apiKey?: string; baseUrl?: string | null }) =>
      getApi().providers.testKey(data)
  })
}

/**
 * Look for an Ollama running on this machine.
 *
 * A **query**, not a mutation, and deliberately so: it is a fact about the
 * machine that two surfaces read (the credentials section, and the Add form when
 * Ollama is picked), and sharing one cache entry means opening the form after
 * the section has already probed costs nothing and shows no second spinner.
 *
 * `enabled` is the caller's, because this must not run on every screen that
 * happens to mount a provider list. It never retries: the answer to "nothing is
 * listening" does not improve by asking three more times, and a retry would keep
 * the surface in a loading state for the several seconds a user would read as
 * the app being stuck.
 */
export function useOllamaDetection(options: { enabled?: boolean; host?: string | null } = {}) {
  const { enabled = true, host = null } = options
  return useQuery<OllamaDetectionData>({
    queryKey: ['ollama-detection', host],
    queryFn: () => getApi().providers.detectOllama(host),
    enabled,
    retry: false,
    // The previous answer stays on screen while a new probe runs. Without it,
    // pressing Test emptied `data` for the duration of the request, the Default
    // Model select unmounted, and the Cancel/Test/Save row jumped 64px up —
    // putting Save exactly where the pointer had just pressed Test (rule 1).
    placeholderData: keepPreviousData,
    /**
     * Refetched on focus, against this app's global default of `false`.
     *
     * That default is right for almost everything here — a chat list does not
     * change because you alt-tabbed. This is the exception, and it is the whole
     * point of the query: "is Ollama running on this machine" changes *out of
     * band*, in a terminal, while the user is looking at another window. Coming
     * back to find the offer row now present is the behaviour; having to leave
     * Settings and re-enter is not.
     *
     * Safe here specifically: the probe is loopback, `enabled` keeps it to the
     * screens that ask for it, and the only thing it can move is the offer row,
     * which sits below everything (rule 1).
     *
     * This comment used to claim focus refetching already happened. It did not —
     * `App.tsx` sets `refetchOnWindowFocus: false` for every query — so the line
     * described a behaviour the feature wanted and did not have.
     */
    refetchOnWindowFocus: true,
    // Not cached indefinitely either, so a probe that ran a minute ago is not
    // still speaking for a server that has since stopped.
    staleTime: 15_000
  })
}
