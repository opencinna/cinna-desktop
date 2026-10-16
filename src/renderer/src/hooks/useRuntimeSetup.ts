import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  ENGINE_LOGIN_NAMES,
  isEngineLoginId,
  loginFailureLead,
  loginPendingText,
  type AgentEngine,
  type EngineBinaryState,
  type EngineLoginId,
  type RuntimeSetupEvent,
  type RuntimeSetupPhase,
  type RuntimeSetupResult,
  type RuntimeSetupRunning
} from '../../../shared/engine'
import {
  ANTIGRAVITY_AUTH_KEY,
  CLAUDE_AUTH_KEY,
  CODEX_AUTH_KEY,
  ENGINE_LOGIN_RUNNING_KEY,
  useAntigravityAuth,
  useClaudeAuth,
  useCodexAuth,
  useEngineLoginRunning
} from './useLocalTools'
import { useUIStore } from '../stores/ui.store'
import type { RuntimeChip, RuntimeChoiceId } from '../components/settings/RuntimeChoiceButtons'

/**
 * **Runtime setup**, as the runtime cards see it.
 *
 * The chain itself — install, ask whether it is signed in, sign in on a
 * definite "signed out" — runs in main (`runtimeSetupService`), so it survives
 * leaving the screen and every surface joins the one run. Here: which engine is
 * in which phase (seeded once, then written from main's push), how the last run
 * of each engine ended, and the call that starts one.
 *
 * **What ends a run is handled from the push** ({@link useRuntimeSetupWatch},
 * mounted once beside `useEngineWatch`) and from the `useMutation` options — never
 * from a mutate-level callback, which is dropped with the screen. A login
 * started in main never passes through `useEngineLogin`'s `onSettled`, so this
 * is where the auth answers, the login-running flag and the agent list are
 * re-read.
 */

export const RUNTIME_SETUP_RUNNING_KEY = ['runtime-setup-running'] as const
export const RUNTIME_SETUP_RESULTS_KEY = ['runtime-setup-results'] as const

const NONE_RUNNING: RuntimeSetupRunning = { claude: null, codex: null, antigravity: null }

type RuntimeSetupResults = Partial<Record<EngineLoginId, RuntimeSetupResult>>

const AUTH_KEY: Record<EngineLoginId, readonly string[]> = {
  claude: CLAUDE_AUTH_KEY,
  codex: CODEX_AUTH_KEY,
  antigravity: ANTIGRAVITY_AUTH_KEY
}

function setResult(queryClient: QueryClient, engine: EngineLoginId, result: RuntimeSetupResult | undefined): void {
  queryClient.setQueryData<RuntimeSetupResults>(RUNTIME_SETUP_RESULTS_KEY, (current) => {
    const next = { ...(current ?? {}) }
    if (result) next[engine] = result
    else delete next[engine]
    return next
  })
}

function setPhase(queryClient: QueryClient, engine: EngineLoginId, phase: RuntimeSetupPhase | null): void {
  queryClient.setQueryData<RuntimeSetupRunning>(RUNTIME_SETUP_RUNNING_KEY, (current) => ({
    ...(current ?? NONE_RUNNING),
    [engine]: phase
  }))
}

/** A run ended: keep its outcome, and re-read everything it may have changed. */
function settle(queryClient: QueryClient, engine: EngineLoginId, result: RuntimeSetupResult): void {
  setResult(queryClient, engine, result)
  void queryClient.invalidateQueries({ queryKey: AUTH_KEY[engine] })
  void queryClient.invalidateQueries({ queryKey: ENGINE_LOGIN_RUNNING_KEY })
  void queryClient.invalidateQueries({ queryKey: ['agents'] })
  void queryClient.invalidateQueries({ queryKey: ['local-development-context'] })
}

/** Write one push from main into the cache. Called by `useRuntimeSetupWatch`. */
export function applyRuntimeSetupEvent(queryClient: QueryClient, event: RuntimeSetupEvent): void {
  queryClient.setQueryData(RUNTIME_SETUP_RUNNING_KEY, event.running)
  // A login main just started is not one this window asked for: re-read the
  // running flag so the phase (`preparing` → `waiting`) and Cancel show.
  if (Object.values(event.running).includes('signing_in')) {
    void queryClient.invalidateQueries({ queryKey: ENGINE_LOGIN_RUNNING_KEY })
  }
  if (event.ended) settle(queryClient, event.ended.engine, event.ended.result)
}

/**
 * Subscribe to main's setup pushes for the app's lifetime. Mount once, high in
 * the tree, beside `useEngineWatch`.
 */
export function useRuntimeSetupWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => window.api.localTools.onRuntimeSetup((event) => applyRuntimeSetupEvent(queryClient, event)), [queryClient])
}

export function useRuntimeSetupRunning() {
  return useQuery<RuntimeSetupRunning>({
    queryKey: RUNTIME_SETUP_RUNNING_KEY,
    queryFn: () => window.api.localTools.runtimeSetupRunning(),
    // Written from main's push; the fetch only seeds a surface mounted mid-run.
    staleTime: Infinity
  })
}

export interface SetupOptions {
  install: boolean
  login?: 'auto' | 'force'
}

export interface RuntimeSetupControl {
  phase: (engine: EngineLoginId) => RuntimeSetupPhase | null
  result: (engine: EngineLoginId) => RuntimeSetupResult | null
  /**
   * Start (or join) a setup. `install: false` never downloads anything;
   * `login: 'force'` is the user's own Log in — main logs in unless signed in.
   */
  setup: (engine: EngineLoginId, options: SetupOptions) => void
  /** Cancel the engine's setup and its login. */
  cancel: (engine: EngineLoginId) => void
}

/**
 * The setup call and what is known about runs. Own it in the section, not in
 * the chip that fires it: the chip changes on the click.
 */
export function useRuntimeSetup(): RuntimeSetupControl {
  const queryClient = useQueryClient()
  const { data: running } = useRuntimeSetupRunning()
  const { data: results } = useQuery<RuntimeSetupResults>({
    queryKey: RUNTIME_SETUP_RESULTS_KEY,
    // Never fetched: written by the push and by the mutation below.
    queryFn: () => queryClient.getQueryData<RuntimeSetupResults>(RUNTIME_SETUP_RESULTS_KEY) ?? {},
    initialData: {},
    staleTime: Infinity
  })
  const mutation = useMutation<RuntimeSetupResult, Error, { engine: EngineLoginId } & SetupOptions>({
    mutationFn: ({ engine, install, login }) => {
      // Shown at once, before main's first push: the chip the user pressed
      // turns into what it started instead of standing still for a beat.
      setResult(queryClient, engine, undefined)
      setPhase(queryClient, engine, install ? 'installing' : 'checking')
      return window.api.localTools.runtimeSetup(engine, { install, login: login ?? 'auto' })
    },
    onSuccess: (result, { engine }) => {
      setPhase(queryClient, engine, null)
      settle(queryClient, engine, result)
    },
    onError: (_error, { engine }) => {
      setPhase(queryClient, engine, null)
    }
  })
  const { mutate } = mutation
  return {
    phase: (engine) => running?.[engine] ?? null,
    result: (engine) => results?.[engine] ?? null,
    setup: (engine, options) => mutate({ engine, ...options }),
    cancel: (engine) => {
      void window.api.localTools
        .runtimeSetupCancel(engine)
        .catch(() => false)
        .finally(() => queryClient.invalidateQueries({ queryKey: ENGINE_LOGIN_RUNNING_KEY }))
    }
  }
}

/** What the status line under the cards says about a setup, when it has something to say. */
export interface RuntimeSetupStatus {
  text: string
  tone: 'muted' | 'danger'
  /** A Cancel belongs beside the line: a login is running. */
  cancel?: () => void
}

export interface RuntimeCardSetup {
  /** The chip each card shows, by choice id. */
  chips: Partial<Record<RuntimeChoiceId, RuntimeChip>>
  onChip: (id: RuntimeChoiceId) => void
  /**
   * The user picked a card. An installed runtime is then asked whether it is
   * signed in, and signed in on a definite "no" — a gesture, so a login may
   * open. A runtime that is not on disk is only selected; its Install chip is
   * the one way to download it.
   */
  afterSelect: (engine: AgentEngine) => void
  /** The setup's line for the selected runtime, or null to show the normal status. */
  status: RuntimeSetupStatus | null
  /** Antigravity is selected and not yet ready: its terms belong in the line. */
  antigravityTerms: boolean
}

function percentOf(binary: EngineBinaryState | undefined): number | null {
  if (binary?.state !== 'resolving' || binary.received === undefined) return null
  const total = binary.assetBytes ?? binary.total
  return total ? Math.min(99, Math.floor((binary.received / total) * 100)) : null
}

/**
 * Chips, the after-select chain and the setup's status line for one surface's
 * runtime cards. Only the selected engine's login is asked — a card the user
 * is not on is not worth a `claude auth status`.
 */
export function useRuntimeCardSetup({
  selected,
  binaries,
  pathSet,
  hasOpenCodeCredential
}: {
  selected: AgentEngine | null
  binaries: Record<EngineLoginId, EngineBinaryState | undefined>
  pathSet: Record<EngineLoginId, boolean>
  /** Undefined while credentials load: no chip is claimed on a guess. */
  hasOpenCodeCredential: boolean | undefined
}): RuntimeCardSetup {
  const control = useRuntimeSetup()
  const { data: claudeAuth } = useClaudeAuth({ enabled: selected === 'claude' })
  const { data: codexAuth } = useCodexAuth({ enabled: selected === 'codex' })
  const { data: antigravityAuth } = useAntigravityAuth({ enabled: selected === 'antigravity' })
  const loginEngine = isEngineLoginId(selected) ? selected : null
  const { data: loginRunning } = useEngineLoginRunning(loginEngine !== null)
  const authState: Record<EngineLoginId, string | undefined> = {
    claude: claudeAuth?.state,
    codex: codexAuth?.state,
    antigravity: antigravityAuth?.state
  }

  const chips: Partial<Record<RuntimeChoiceId, RuntimeChip>> = {}
  let status: RuntimeSetupStatus | null = null
  let antigravityTerms = false

  if (loginEngine) {
    const engine = loginEngine
    const binary = binaries[engine]
    const phase = control.phase(engine)
    const loginPhase = loginRunning?.[engine] ?? null
    const result = control.result(engine)
    const signingIn = phase === 'signing_in' || loginPhase !== null
    const installing = phase === 'installing' || binary?.state === 'resolving'
    const auth = authState[engine]

    if (signingIn) chips[engine] = { kind: 'logging_in' }
    else if (installing) {
      // A configured path resolving is a `--version`, not a download.
      if (!pathSet[engine]) chips[engine] = { kind: 'installing', percent: percentOf(binary) }
    } else if (phase === null && !pathSet[engine] && binary?.state === 'unresolved') chips[engine] = { kind: 'install' }
    else if (phase === null && !pathSet[engine] && binary?.state === 'failed') chips[engine] = { kind: 'retry' }
    else if (phase === null && binary?.state === 'ready' && auth === 'logged_out') chips[engine] = { kind: 'log_in' }
    // All set: the green dot. `unknown`, or not answered yet, claims nothing.
    else if (phase === null && binary?.state === 'ready' && auth === 'logged_in') chips[engine] = { kind: 'ready' }

    /** A failed sign-in's own sentence; null for one with nothing to add, which falls through. */
    const loginLead =
      result?.outcome === 'login_failed' && auth !== 'logged_in' ? loginFailureLead(result.login) : null
    /**
     * An install that failed somewhere the binary's state does not say — a
     * thrown look, a refusal before the resolver ran. When the state already
     * reads `failed` with this sentence, the binary's own line says it.
     */
    const installReason =
      result?.outcome === 'install_failed' &&
      // A binary that has since become ready (a saved Path, a turn's download) outdates it.
      binary?.state !== 'ready' &&
      !(binary?.state === 'failed' && binary.error === result.reason)
        ? result.reason
        : null

    if (signingIn) {
      status = {
        text: loginPendingText(engine, loginPhase ?? 'preparing'),
        tone: 'muted',
        cancel: () => control.cancel(engine)
      }
    } else if (phase === 'checking') {
      status = { text: 'Checking login…', tone: 'muted' }
    } else if (!installing && installReason) {
      status = { text: installReason, tone: 'danger' }
    } else if (!installing && loginLead) {
      status = { text: loginLead, tone: 'danger' }
    } else if (!installing && binary?.state === 'ready' && auth === 'logged_out') {
      // Also where a cancelled login lands: the chip offers Log in, so the
      // line must say why rather than read as ready (ux_rules rule 9).
      status = { text: `${ENGINE_LOGIN_NAMES[engine]} is not logged in.`, tone: 'danger' }
    }

    /**
     * Only on a known not-ready state: an answer still loading is not one, so
     * the usual visit to a signed-in Antigravity never flips the line.
     */
    const binaryNotReady =
      binary?.state === 'unresolved' || binary?.state === 'failed' || binary?.state === 'resolving'
    antigravityTerms =
      engine === 'antigravity' &&
      (phase !== null || signingIn || binaryNotReady || auth === 'logged_out' || auth === 'unknown')
  } else if (selected === 'opencode' && hasOpenCodeCredential !== undefined) {
    chips.opencode = hasOpenCodeCredential ? { kind: 'ready' } : { kind: 'add_credential' }
  }

  return {
    chips,
    onChip: (id) => {
      const chip = chips[id]
      if (!chip) return
      if (chip.kind === 'add_credential') {
        useUIStore.getState().setSettingsMenu('llm')
        useUIStore.getState().setActiveView('settings')
        return
      }
      if (!isEngineLoginId(id)) return
      if (chip.kind === 'install' || chip.kind === 'retry') control.setup(id, { install: true })
      // The user asked to log in: main logs in unless the probe says they are.
      else if (chip.kind === 'log_in') control.setup(id, { install: false, login: 'force' })
    },
    afterSelect: (engine) => {
      if (!isEngineLoginId(engine)) return
      const state = binaries[engine]?.state
      if (state === 'ready' || state === 'resolving') control.setup(engine, { install: false })
    },
    status,
    antigravityTerms
  }
}
