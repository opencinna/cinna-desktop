/**
 * Where the `opencode` binary is, and whether we have one yet — all that is
 * left of "the engine" as a thing the app has state about.
 *
 * ## Why this replaces a process manager
 *
 * Before phase 3 of the agent runtime plan there was one long-lived
 * `opencode serve` behind every folder agent, and `engineManager` was a state
 * machine around it: resolve, download, spawn, health-check, restart on a
 * config change, stop at quit, and push `stopped | installing | starting |
 * running | failed` to the UI. Every one of those states was about a *server*.
 *
 * The ACP driver starts a child per agent, lazily, and reaps it when it goes
 * idle — so there is no server to be up or down, and nothing for a user to
 * start. What is left of the old state machine is the one question that
 * outlives any turn: **is there a usable binary on this machine, and where did
 * it come from.** That is worth showing, because the answer can be "we will
 * download 46 MB the first time you chat" and because a *failed* resolution
 * (a bad path in Settings) is a thing only the user can fix.
 *
 * ## What it does not do
 *
 * It never resolves on its own. A resolution can download and verify a pinned
 * archive, which is a minute of work and 46 MB of traffic, so it happens where
 * it always did — at the top of a turn, through the launcher — or when the user
 * asks for it in Settings. Reading the state is free and answers `unresolved`
 * until something has actually looked.
 */

import type { EngineBinaryState } from '../../shared/engine'
import { createLogger } from '../logger/logger'
import {
  configuredEnginePath,
  realBinaryResolverDeps,
  resolveEngineBinaryWith,
  type ResolvedEngineBinary
} from './binaryResolver'

const logger = createLogger('engine-binary')

export interface EngineBinaryDeps {
  /** Resolve one — may download. Injected so a test needs no network. */
  resolve(configured: string | null): Promise<ResolvedEngineBinary>
  /** The explicit path from Settings, or null. */
  configuredPath(): string | null
}

const productionDeps: EngineBinaryDeps = {
  resolve: (configured) => resolveEngineBinaryWith(realBinaryResolverDeps(() => configured)),
  configuredPath: configuredEnginePath
}

export interface EngineBinaryService {
  /** What is known right now. Free, and never starts a resolution. */
  state(): EngineBinaryState
  /**
   * The resolved binary, resolving it if nobody has yet.
   *
   * **Memoised per configured path**, not merely per app run: a user who
   * changes the path in Settings gets the new binary on the next turn, and
   * because the path feeds the launch spec's key, their running agents are
   * replaced rather than left on the old one. A failed resolution is not cached
   * — a bad path the user has since fixed must not be answered from memory.
   *
   * Concurrent callers share one resolution: two turns starting together would
   * otherwise download the same archive twice into the same directory.
   */
  ensure(): Promise<ResolvedEngineBinary>
  /** Resolve again from scratch — Settings' *Check again*. */
  refresh(): Promise<EngineBinaryState>
  /** Called with the new state whenever it changes. Returns unsubscribe. */
  onChange(listener: (state: EngineBinaryState) => void): () => void
}

export function createEngineBinaryService(
  deps: EngineBinaryDeps = productionDeps
): EngineBinaryService {
  let state: EngineBinaryState = { state: 'unresolved' }
  let pending: Promise<ResolvedEngineBinary> | null = null
  let pendingFor: string | null | undefined
  /**
   * Which resolution owns {@link pending} right now.
   *
   * A token rather than the promise itself, because the failure handler has to
   * ask "is the slot still mine" from inside the very expression that assigns
   * it — and a token can be created a line earlier where the promise cannot.
   */
  let pendingToken: object | null = null
  const listeners = new Set<(state: EngineBinaryState) => void>()

  const setState = (next: EngineBinaryState): void => {
    state = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (err) {
        logger.warn('an engine binary listener threw', { error: String(err) })
      }
    }
  }

  const start = (configured: string | null): Promise<ResolvedEngineBinary> => {
    setState({ state: 'resolving' })
    const token = {}
    /**
     * **Only the current resolution reports anything.**
     *
     * A `refresh` can overtake one that is still running — that is what it is
     * for — and the one it overtook then finishes and has an answer. Letting it
     * speak would put a stale state on the screen: the commonest shape is a
     * user who fixes a bad path, gets `ready`, and watches it flip back to the
     * old error a moment later. Its caller still gets its own answer; what it
     * loses is the microphone.
     */
    const owns = (): boolean => pendingToken === token
    const run = deps.resolve(configured).then(
      (binary) => {
        if (owns()) {
          setState({
            state: 'ready',
            path: binary.path,
            source: binary.source,
            version: binary.version
          })
        }
        return binary
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('could not resolve the engine binary', { error: message })
        if (owns()) {
          // Not cached: the two failures that happen are a path the user typed
          // wrongly and a download that could not reach the network, and both
          // are fixed by trying again.
          pending = null
          pendingFor = undefined
          pendingToken = null
          setState({ state: 'failed', error: message })
        }
        throw err
      }
    )
    pending = run
    pendingFor = configured
    pendingToken = token
    return run
  }

  return {
    state: () => state,
    ensure: () => {
      const configured = deps.configuredPath()
      if (pending && pendingFor === configured) return pending
      return start(configured)
    },
    refresh: async () => {
      pending = null
      pendingFor = undefined
      pendingToken = null
      try {
        await start(deps.configuredPath())
      } catch {
        // The state carries the failure; a refusal here would make the caller
        // handle the same message twice.
      }
      return state
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export const engineBinaryService = createEngineBinaryService()
