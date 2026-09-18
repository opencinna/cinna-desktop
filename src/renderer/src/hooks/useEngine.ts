import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DefaultEngineDto, EngineBinaryState } from '../../../shared/engine'

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
    const offEngine = window.api.engine.onState((state) => {
      queryClient.setQueryData(ENGINE_BINARY_KEY, state)
    })
    // The managed Codex CLI pushes on its own channel, download progress
    // included — one subscription beside the engine's, for the same lifetime.
    const offCodex = window.api.engine.onCodexState((state) => {
      queryClient.setQueryData(CODEX_BINARY_KEY, state)
    })
    return () => {
      offEngine()
      offCodex()
    }
  }, [queryClient])
}

export const CODEX_BINARY_KEY = ['codex-binary'] as const

/**
 * The managed Codex CLI, as Settings sees it: the pinned copy Cinna installs,
 * or the explicit path the user set. Seeded once and then written from main's
 * pushes, like {@link useEngineBinary} — the interesting transition is a ~90 MB
 * download that the user who triggered it (by sending a message) is not
 * watching from here.
 */
export function useCodexBinary() {
  return useQuery<EngineBinaryState>({
    queryKey: CODEX_BINARY_KEY,
    queryFn: () => window.api.engine.codexBinary()
  })
}

/**
 * Install or re-check the Codex CLI now — the row's *Install now* / *Try again*.
 *
 * Owned by the settings section, not by the text action that fires it: pressing
 * it moves the state to `resolving`, which unmounts that action, and a
 * mutate-level callback would be dropped with it. Resolves with a `failed`
 * state rather than rejecting, so the caller renders `data.error`.
 */
export function useResolveCodexBinary() {
  const queryClient = useQueryClient()
  return useMutation<EngineBinaryState>({
    mutationFn: () => window.api.engine.resolveCodex(),
    onSuccess: (state) => queryClient.setQueryData(CODEX_BINARY_KEY, state)
  })
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

export const DEFAULT_RUNTIME_KEY = ['default-runtime'] as const

/**
 * This machine's **Default Runtime** — what a folder agent that names no engine
 * of its own runs on.
 *
 * Answered by main, not assembled here out of `useAppSettings` and
 * `useLocalTools`. The renderer holds both halves and could do the sum, and
 * that is exactly the arrangement that has twice let this area's panel predict
 * a runtime the launcher did not build. It also arrives as **one** value:
 * summed here it would read "AI credentials" while tool detection was in flight
 * and then flip, which on the agent page swaps a picker under the pointer
 * (ux_rules rule 1). `undefined` is *not known yet*, and every caller renders
 * that as a claim withheld rather than as a negative.
 *
 * Invalidate it whenever either half moves: the setting (`useSetAppSetting`
 * cannot know, so the Settings screen does it) and detection (a Refresh, or an
 * install that just succeeded).
 */
export function useDefaultRuntime() {
  return useQuery<DefaultEngineDto>({
    queryKey: DEFAULT_RUNTIME_KEY,
    queryFn: () => window.api.engine.defaultRuntime(),
    staleTime: Infinity
  })
}
