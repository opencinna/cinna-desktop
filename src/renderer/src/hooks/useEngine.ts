import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EngineSkips, EngineState } from '../../../shared/engine'

/**
 * The local engine, as the Runtime card and Settings see it.
 *
 * State lives in main and is pushed on every transition, so nothing here polls:
 * the query is seeded once and then written straight from the push. That
 * matters more than usual because the interesting transitions are slow and
 * unattended — a first-use download runs for a minute, and a crash happens
 * while nobody is looking at the screen.
 */

export const ENGINE_STATE_KEY = ['engine-state'] as const
export const ENGINE_SKIPS_KEY = ['engine-skips'] as const

export function useEngineState() {
  return useQuery<EngineState>({
    queryKey: ENGINE_STATE_KEY,
    queryFn: () => window.api.engine.status()
  })
}

/**
 * Subscribe to main's engine pushes for the app's lifetime. Mount once, high in
 * the tree, alongside `useLocalAgentWatch`.
 */
export function useEngineWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    return window.api.engine.onState((state) => {
      queryClient.setQueryData(ENGINE_STATE_KEY, state)
      // The skip list is only ever recomputed by a config generation, and a
      // config generation always moves the state — so this push is exactly the
      // signal that the list may be stale, and the alternative would be
      // polling a value that changes a handful of times a session.
      queryClient.invalidateQueries({ queryKey: ENGINE_SKIPS_KEY })
    })
  }, [queryClient])
}

/**
 * Which folder agents the engine's current config left out, and why.
 *
 * Empty until the engine has generated a config at least once. A card reading
 * this must therefore treat "no entry for my agent" as "nothing known", not as
 * "this agent is fine" — the engine may simply never have started.
 */
export function useEngineSkips() {
  return useQuery<EngineSkips>({
    queryKey: ENGINE_SKIPS_KEY,
    queryFn: () => window.api.engine.skips()
  })
}

/**
 * Start the engine, installing it first if this machine has none.
 *
 * Resolves with the resulting state even when the start failed — main returns a
 * `failed` state rather than rejecting — so the caller renders `data.error`
 * instead of a mutation error. `isPending` covers the download, which can be a
 * minute on first use.
 *
 * The agent page's Runs-with panel is the only caller. Settings had a
 * Start/Stop button too, and it is gone: `ensureEngineRunning` starts the
 * engine at the top of every local turn, so on that screen it was a control for
 * doing by hand what chatting does anyway. There is no `useStopEngine` for the
 * same reason — nothing in the UI stops the engine, and the next message would
 * start it again.
 */
export function useStartEngine() {
  const queryClient = useQueryClient()
  return useMutation<EngineState>({
    mutationFn: () => window.api.engine.start(),
    onSuccess: (state) => queryClient.setQueryData(ENGINE_STATE_KEY, state)
  })
}
