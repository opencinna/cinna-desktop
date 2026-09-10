import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EngineBinaryState } from '../../../shared/engine'

/**
 * The local engine's binary, as Settings and the Runs-with panel see it.
 *
 * State lives in main and is pushed on every transition, so nothing here polls:
 * the query is seeded once and then written straight from the push. That
 * matters more than usual because the one interesting transition is slow and
 * unattended — a first-use download runs for about a minute, and the user who
 * triggered it by sending a message is watching the chat, not this.
 *
 * There is no `useStartEngine` any more, and no skip list. Phase 3 of the agent
 * runtime plan took the shared `opencode serve` away: a turn spawns its own
 * child and speaks the Agent Client Protocol to it, so nothing in the UI starts
 * or stops anything, and which agents a shared config left out is a question
 * that no longer exists — a launcher refuses one agent, at the top of its own
 * turn, in words.
 */

export const ENGINE_BINARY_KEY = ['engine-binary'] as const

export function useEngineBinary() {
  return useQuery<EngineBinaryState>({
    queryKey: ENGINE_BINARY_KEY,
    queryFn: () => window.api.engine.binary()
  })
}

/**
 * Subscribe to main's pushes for the app's lifetime. Mount once, high in the
 * tree, alongside `useLocalAgentWatch`.
 */
export function useEngineWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    return window.api.engine.onState((state) => {
      queryClient.setQueryData(ENGINE_BINARY_KEY, state)
    })
  }, [queryClient])
}

/**
 * Resolve the binary now — Settings' *Check again*.
 *
 * Resolves with the resulting state even when the resolution failed: main
 * returns a `failed` state rather than rejecting, so the caller renders
 * `data.error` instead of a mutation error. `isPending` covers the download,
 * which is about a minute on first use.
 *
 * Nothing else asks for one. A turn resolves it on its own, which is why this
 * exists only for the two states a user can act on: a path in Settings that
 * does not work, and the wish to get the download over with before chatting.
 */
export function useResolveEngineBinary() {
  const queryClient = useQueryClient()
  return useMutation<EngineBinaryState>({
    mutationFn: () => window.api.engine.resolve(),
    onSuccess: (state) => queryClient.setQueryData(ENGINE_BINARY_KEY, state)
  })
}
