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
  configuredCodexPath,
  configuredEnginePath,
  realBinaryResolverDeps,
  realCodexResolverDeps,
  resolveEngineBinaryWith,
  type ResolvedEngineBinary
} from './binaryResolver'
import { isFile, type DownloadProgress } from '../managed/managedAsset'

const logger = createLogger('engine-binary')

export interface EngineBinaryDeps {
  /**
   * Resolve one — may download. Injected so a test needs no network.
   *
   * `onProgress` is offered to every resolution and used by the ones whose
   * download is long enough to be worth a number. A resolver that ignores it
   * leaves the state a bare `resolving`, exactly as before it existed.
   */
  resolve(configured: string | null, onProgress?: DownloadProgress): Promise<ResolvedEngineBinary>
  /** The explicit path from Settings, or null. */
  configuredPath(): string | null
  /**
   * Is the memoised binary still a file. One stat per `ensure`, which is once
   * per turn. Optional so a caller with nothing on disk (a test) keeps the memo
   * unconditionally; both production services pass it.
   */
  exists?(path: string): Promise<boolean>
}

const productionDeps: EngineBinaryDeps = {
  resolve: (configured) => resolveEngineBinaryWith(realBinaryResolverDeps(() => configured)),
  configuredPath: configuredEnginePath,
  exists: isFile
}

/**
 * The managed Codex CLI: the same service over the Codex resolver.
 *
 * It forwards download progress, which OpenCode's deps deliberately do not —
 * 90 MB is a wait a user watches, where 46 MB was a sentence saying "about a
 * minute".
 */
const codexProductionDeps: EngineBinaryDeps = {
  resolve: (configured, onProgress) =>
    resolveEngineBinaryWith(realCodexResolverDeps(() => configured), onProgress),
  configuredPath: configuredCodexPath,
  exists: isFile
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
   *
   * **A remembered binary is checked before it is handed out.** The memo lasts
   * the whole run, and `<userData>/runtimes/codex-*` can be deleted under it —
   * by the user, by a cleaner, by a newer install sweeping old versions. Answering
   * from memory then spawns a path that is not there, for every turn until a
   * restart. One stat; when the file is gone the binary is resolved again,
   * which for a managed copy means it is downloaded again.
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
    // Progress obeys the same rule as the outcome: an overtaken resolution's
    // bytes must not repaint a row that now belongs to a newer one.
    const onProgress: DownloadProgress = (received, total) => {
      if (owns()) setState({ state: 'resolving', received, total })
    }
    const run = deps.resolve(configured, onProgress).then(
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
    ensure: function ensure(): Promise<ResolvedEngineBinary> {
      const configured = deps.configuredPath()
      if (!pending || pendingFor !== configured) return start(configured)
      const remembered = pending
      if (!deps.exists) return remembered
      const exists = deps.exists
      // A failure passes straight through, as before: it was never cached.
      return remembered.then(async (binary) => {
        if (await exists(binary.path)) return binary
        // Somebody else may have noticed first (two turns starting together):
        // then theirs is the resolution to share, not a second download.
        if (pending !== remembered) return ensure()
        logger.warn('the resolved binary is gone from disk; resolving again', { source: binary.source })
        return start(configured)
      })
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

/** The managed Codex CLI every Cinna-spawned Codex session runs on. */
export const codexBinaryService = createEngineBinaryService(codexProductionDeps)
