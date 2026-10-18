import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentEngine } from '../../../shared/engine'
import type { RuntimeModelCatalogRefresh } from '../../../shared/runtimeModelCatalog'
import { useAuthStore } from '../stores/auth.store'
import { useAntigravityAuth, useClaudeAuth, useCodexAuth } from './useLocalTools'
import { useAntigravityBinary, useClaudeBinary, useCodexBinary } from './useEngine'

const isCliEngine = (engine: AgentEngine | null | undefined): boolean =>
  engine === 'claude' || engine === 'codex' || engine === 'antigravity'

/** The cache key of one profile's catalogue for one runtime. */
const catalogKey = (profile: string | null, engine: AgentEngine | null | undefined): unknown[] =>
  ['runtime-model-catalog', profile, engine]

/**
 * Reading a catalog never launches a runtime; entries come from prior ACP
 * sessions (or Codex's own cache), kept across restarts. Keyed by the profile
 * too, so a catalogue never answers for a profile it was not read for.
 */
export function useRuntimeModelCatalog(engine: AgentEngine | null | undefined) {
  const profile = useAuthStore((state) => state.currentUser?.id ?? null)
  return useQuery({
    queryKey: catalogKey(profile, engine),
    queryFn: () => window.api.engine.modelCatalog(engine!),
    enabled: isCliEngine(engine),
    staleTime: 0
  })
}

/**
 * **Ask the runtime for its models now** — main opens a session with no prompt
 * and closes it — while `wanted` holds, or when {@link retry} is pressed.
 *
 * One query per profile, engine and **readiness**: the engine's login and
 * binary state are part of the key, so signing in or fixing the install asks
 * again at once rather than leaving the last failure standing. Otherwise an
 * answer — a failure included — is not repeated for ten minutes, so remounts
 * do not spawn the runtime again; `retry` bypasses that. Every surface that
 * wants a refresh shares the one in flight, and main single-flights it again.
 * The fresh catalogue lands in {@link useRuntimeModelCatalog}'s cache — unless
 * the profile changed while it ran, in which case it belongs to nobody here.
 */
export function useRuntimeModelCatalogRefresh(engine: AgentEngine | null | undefined, wanted: boolean) {
  const queryClient = useQueryClient()
  const profile = useAuthStore((state) => state.currentUser?.id ?? null)
  const [forced, setForced] = useState(0)
  const active = isCliEngine(engine) && (wanted || forced > 0)
  const on = (name: AgentEngine): boolean => active && engine === name
  const auth = {
    claude: useClaudeAuth({ enabled: on('claude') }).data?.state,
    codex: useCodexAuth({ enabled: on('codex') }).data?.state,
    antigravity: useAntigravityAuth({ enabled: on('antigravity') }).data?.state
  }
  const binary = {
    claude: useClaudeBinary({ enabled: on('claude') }).data?.state,
    codex: useCodexBinary({ enabled: on('codex') }).data?.state,
    antigravity: useAntigravityBinary({ enabled: on('antigravity') }).data?.state
  }
  const cli = isCliEngine(engine) ? (engine as 'claude' | 'codex' | 'antigravity') : null
  const readiness = cli ? [auth[cli], binary[cli]] : [undefined, undefined]
  /**
   * Keyed on one boolean, not the raw states: only becoming ready (signed in,
   * binary present) or ceasing to be is worth another probe. Every
   * intermediate value (`resolving`, `unknown`) would otherwise spawn one.
   */
  const ready = cli ? auth[cli] === 'logged_in' && binary[cli] === 'ready' : false
  const query = useQuery({
    queryKey: ['runtime-model-catalog-refresh', profile, engine, ready, forced],
    queryFn: async (): Promise<RuntimeModelCatalogRefresh> => {
      const result = await window.api.engine.refreshModelCatalog(engine!)
      // A profile switch while main was asking: the answer is the old profile's.
      if (useAuthStore.getState().currentUser?.id === profile) queryClient.setQueryData(catalogKey(profile, engine), result.catalog)
      return result
    },
    // Only once readiness is known, so its arrival is not a second refresh.
    enabled: active && readiness.every((part) => part !== undefined),
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false
  })
  return { ...query, retry: () => setForced((count) => count + 1) }
}
