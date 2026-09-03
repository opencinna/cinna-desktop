/**
 * Folder watching — how an edit made outside the app reaches the agents list.
 *
 * Three parties write these folders (the desktop, an assistant, the agent
 * itself), so the app cannot assume the index it wrote is still true. One
 * debounced watcher per root notices a change, works out which agent it belongs
 * to, rescans just that agent, and pushes `local-agent:changed` to the renderer
 * the way `mcp:status-changed` and `agents:remote-sync-complete` do.
 *
 * ## What `fs.watch` actually gives us, and what is done about it
 *
 * `fs.watch` is the fastest thing available and the least reliable. Four
 * specific weaknesses, and the response to each:
 *
 * 1. **Atomic saves and renames.** Almost every editor writes `file.tmp` and
 *    renames it over the target, which replaces the inode. A watcher attached
 *    to a *file* dies at that moment. So nothing here ever watches a file —
 *    only directories, whose identity survives their contents being replaced.
 *    The rename shows up as a `rename` event on the parent, which is exactly
 *    the signal wanted.
 * 2. **Missing and ambiguous event paths.** The `filename` argument is optional
 *    by contract, absent on some platforms, and on macOS can arrive
 *    Unicode-decomposed. Any event whose path cannot be mapped to a specific
 *    agent falls back to rescanning the whole root, so a lost path costs a
 *    little work rather than a stale list.
 * 3. **Recursive watching is not portable.** `{ recursive: true }` is macOS and
 *    Windows only; on Linux it throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
 *    The recursive watcher is attempted first and, when it is refused, a
 *    per-directory fallback is used: one watcher on `Local/` plus one per agent
 *    folder, re-armed after each scan so a newly created agent is covered.
 * 4. **Watchers die silently.** A watched directory that is deleted, renamed or
 *    unmounted emits `error` (or simply stops). Every watcher carries an error
 *    handler that closes it and re-arms once, with a delay — so an unmounted
 *    volume that comes back is picked up without a restart, and a permanently
 *    gone folder stops after one retry instead of looping.
 *
 * Two things it deliberately does **not** act on: `app-data/`, which the agent
 * itself writes constantly (a status refresh mid-turn would otherwise loop the
 * scanner), and anything while a turn holds the per-agent lock — the rescan is
 * deferred to `turnLock.whenFree` instead, so the index is rebuilt from a
 * settled folder rather than a half-written one.
 *
 * **Both** rescan branches defer, not just the per-agent one. A whole-root scan
 * touches every agent in the root, so running it mid-turn is the same hazard at
 * a larger scale — and it is the branch an unattributable event falls back to,
 * so a per-agent-only guard could be sidestepped by a platform that simply did
 * not name the file that changed.
 *
 * "Does not act on" is load-bearing and is why {@link classifyEvent} returns a
 * three-way result rather than a nullable path. `ignore`, `root` and `agent` are
 * three different instructions; folding the first two together made every write
 * under `app-data/` schedule a full walk, parse and re-index of every agent in
 * the root — the most expensive response available, on the one directory the
 * paragraph above says is not watched.
 *
 * Watchers are process-lifetime resources: `stopAll()` runs on `will-quit`, and
 * removing a root closes its watcher immediately.
 */

import { readdirSync, watch, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import { app } from 'electron'
import type { AgentRootRow } from '../../db/agentRoots'
import { createLogger } from '../../logger/logger'
import {
  AGENTS_SUBDIR,
  LOCAL_AGENT_CHANGED_CHANNEL,
  type LocalAgentChangedPayload
} from '../../../shared/localAgents'
import { getMainWindow } from '../../index'
import { turnLock } from './turnLock'

const logger = createLogger('local-agent-watch')

/**
 * How long to wait after the last event before acting. Long enough to collapse
 * the burst a multi-file save produces, short enough that the list feels live.
 */
const DEBOUNCE_MS = 400

/** Delay before re-arming a watcher that errored, so a dead path cannot spin. */
const REARM_DELAY_MS = 2_000

/** Directory whose churn is the agent's own runtime noise, never a definition. */
const IGNORED_SEGMENT = 'app-data'

/**
 * Sub-directories the per-directory fallback watches in addition to the agent
 * root. Without recursion a change one level down is invisible, and both of
 * these change readiness:
 *
 * * `docs/` holds the three prompt documents the page edits.
 * * `credentials/` holds `.env`, whose contents flip an agent between
 *   `credentials_needed` and `ok` — the transition the readiness strip exists
 *   to show. Only key *names* are ever read from it (Invariant 4); the watcher
 *   reacts to the file changing, never to what is in it.
 */
const WATCHED_SUBDIRS = ['docs', 'credentials'] as const

interface RootWatch {
  root: AgentRootRow
  watchers: FSWatcher[]
  /** Agent directories with a rescan pending, or `null` for "the whole root". */
  pending: Set<string>
  pendingWholeRoot: boolean
  timer: NodeJS.Timeout | null
  /**
   * True when one recursive handle covers the whole root. The per-directory
   * fallback needs re-arming as agents come and go; a recursive watcher does
   * not, and tracking it explicitly beats inferring it from the handle count
   * (a root with no agents yet has exactly one fallback handle too).
   */
  recursive: boolean
  /** One re-arm attempt per watcher generation; cleared by a successful scan. */
  rearmed: boolean
  closed: boolean
}

/** What the watcher calls when a change has settled. Injected, so this module
 *  never imports the scanner and the two cannot form a cycle. */
export interface WatcherDeps {
  /** Rescan one agent folder and update its index row. */
  rescanAgent: (root: AgentRootRow, agentDir: string) => void
  /** Rescan the whole root. */
  rescanRoot: (root: AgentRootRow) => void
  /** The `agents` row id for a folder, so the push names the agent. */
  agentIdForPath: (agentDir: string) => string | null
  /** Every indexed agent of a root, so a root rescan can wait for their turns. */
  agentIdsForRoot: (root: AgentRootRow) => string[]
}

const watches = new Map<string, RootWatch>()
let deps: WatcherDeps | null = null
let quitHookInstalled = false

/** Push a change to the renderer. Mirrors `notifyRemoteSyncComplete`. */
function broadcast(payload: LocalAgentChangedPayload): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(LOCAL_AGENT_CHANGED_CHANNEL, payload)
  }
}

/**
 * What a watch event means. Three genuinely different answers, and collapsing
 * them loses the distinction that matters most: `ignore` and `root` are not the
 * same instruction, and treating both as "rescan everything" makes the one
 * directory this service deliberately does not watch trigger the single most
 * expensive response it has.
 */
export type WatchTarget =
  /** Nothing to do. The agent's own runtime churn, or bookkeeping. */
  | { kind: 'ignore' }
  /** The root's membership may have changed, or the event was unattributable. */
  | { kind: 'root' }
  /** One agent's definition may have changed. */
  | { kind: 'agent'; dir: string }

/**
 * Classify an event path. Exported because it is the rule that decides what a
 * watch event *means*, and that rule is worth testing without a filesystem race.
 */
export function classifyEvent(rootPath: string, filename: string | null): WatchTarget {
  // No filename: the platform did not tell us what changed (it is optional by
  // contract). A whole-root rescan is the safe fallback — costly, but the
  // alternative is missing a change entirely.
  if (!filename) return { kind: 'root' }

  // A recursive watcher reports paths relative to the watched directory; a
  // per-directory one reports a bare name. Both are handled by taking the first
  // segment.
  const normalized = filename.replace(/\\/g, sep)
  const segments = normalized.split(sep).filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) return { kind: 'root' }

  const [slug, ...rest] = segments
  // Dot-entries: the scaffolder's staging directory, editor bookkeeping,
  // `.DS_Store`. None of them is an agent.
  if (slug.startsWith('.')) return { kind: 'ignore' }

  // `app-data/` is the agent's own runtime storage — `update_status.py` and
  // `desktop.json` churn there constantly while a turn runs. Scanning on that
  // churn is precisely the scanner loop this service exists to avoid, so it is
  // dropped outright rather than downgraded to a root rescan.
  if (rest.includes(IGNORED_SEGMENT)) return { kind: 'ignore' }

  // A bare slug is the agent folder itself appearing or disappearing — that
  // changes the root's membership, and only a root scan can insert or prune.
  if (rest.length === 0) return { kind: 'root' }

  return { kind: 'agent', dir: join(rootPath, AGENTS_SUBDIR, slug) }
}

function flush(state: RootWatch): void {
  state.timer = null
  if (state.closed || !deps) return

  const whole = state.pendingWholeRoot
  const dirs = [...state.pending]
  state.pendingWholeRoot = false
  state.pending.clear()

  if (whole) {
    runWholeRootRescan(state)
    return
  }

  for (const agentDir of dirs) {
    const agentId = deps.agentIdForPath(agentDir)
    const run = (): void => {
      if (state.closed || !deps) return
      try {
        deps.rescanAgent(state.root, agentDir)
        state.rearmed = false
        broadcast({ rootId: state.root.id, agentId, reason: 'watch' })
      } catch (err) {
        logger.error('agent rescan after a watch event failed', {
          rootId: state.root.id,
          error: err
        })
      }
    }
    // Never rebuild the index from a folder a turn is still writing.
    if (agentId && turnLock.isLocked(agentId)) {
      logger.debug('deferring a rescan until the turn finishes', { agentId })
      turnLock.whenFree(agentId, run)
    } else {
      run()
    }
  }
}

/**
 * Rescan a whole root, but never while a turn is streaming into one of its
 * agents.
 *
 * A root rescan walks, parses, validates and re-indexes *every* agent in the
 * root, so running it mid-turn reads folders an agent is still writing — the
 * same hazard the per-agent branch defers for, multiplied by the number of
 * agents. It is also the branch an unattributable event lands on, so without
 * this the deferral could be bypassed by nothing more than a platform that
 * declined to name the file that changed.
 *
 * Waiting on the first held lock and re-checking on release handles several
 * concurrent turns without tracking them: each release re-evaluates, and the
 * scan runs when the last one is gone.
 */
function runWholeRootRescan(state: RootWatch): void {
  if (state.closed || !deps) return

  const locked = deps.agentIdsForRoot(state.root).filter((id) => turnLock.isLocked(id))
  if (locked.length > 0) {
    logger.debug('deferring a root rescan until the turns finish', {
      rootId: state.root.id,
      lockedCount: locked.length
    })
    turnLock.whenFree(locked[0], () => runWholeRootRescan(state))
    return
  }

  try {
    deps.rescanRoot(state.root)
    // The root read cleanly, so this generation of watchers is healthy again
    // and has earned another re-arm if it later dies.
    state.rearmed = false
    broadcast({ rootId: state.root.id, agentId: null, reason: 'watch' })
  } catch (err) {
    logger.error('root rescan after a watch event failed', { rootId: state.root.id, error: err })
  }
  // The agent set may have changed, so the per-directory fallback needs new
  // handles. A recursive watcher already covers them.
  if (!state.closed) armFallbackWatchers(state)
}

function schedule(state: RootWatch, target: WatchTarget): void {
  if (state.closed || target.kind === 'ignore') return
  if (target.kind === 'root') state.pendingWholeRoot = true
  else state.pending.add(target.dir)
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => flush(state), DEBOUNCE_MS)
}

function closeWatchers(state: RootWatch): void {
  for (const watcher of state.watchers) {
    try {
      watcher.close()
    } catch {
      /* already closed, or the handle is gone with its directory */
    }
  }
  state.watchers = []
}

/**
 * Re-arm after a watcher error. Once per generation: a directory that is really
 * gone must not produce an endless retry loop, while an unmounted volume that
 * comes back is picked up on its own.
 */
function rearm(state: RootWatch): void {
  if (state.closed || state.rearmed) return
  state.rearmed = true
  closeWatchers(state)
  setTimeout(() => {
    if (state.closed) return
    logger.info('re-arming the folder watcher', { rootId: state.root.id })
    armWatchers(state)
    // A watcher that died may have missed events; assume the worst.
    schedule(state, { kind: 'root' })
  }, REARM_DELAY_MS)
}

function addWatcher(state: RootWatch, dir: string, recursive: boolean): boolean {
  try {
    const watcher = watch(dir, { recursive, persistent: false }, (_event, filename) => {
      schedule(state, classifyEvent(state.root.path, filename ? String(filename) : null))
    })
    watcher.on('error', (err) => {
      logger.warn('a folder watcher errored', {
        rootId: state.root.id,
        error: err instanceof Error ? err.message : String(err)
      })
      rearm(state)
    })
    state.watchers.push(watcher)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT' && code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
      logger.warn('could not watch a directory', { rootId: state.root.id, code })
    }
    return false
  }
}

/**
 * One watcher per directory — the Linux path, and the fallback anywhere the
 * recursive watcher is refused. Rebuilt from scratch each time the agent set may
 * have changed, so a newly scaffolded folder is covered without restarting the
 * app; stale handles are closed first rather than accumulating.
 */
function armFallbackWatchers(state: RootWatch): void {
  if (state.closed || state.recursive) return
  closeWatchers(state)
  const agentsDir = join(state.root.path, AGENTS_SUBDIR)
  if (!addWatcher(state, agentsDir, false)) return
  for (const agentDir of listAgentDirsSafely(agentsDir)) {
    addWatcher(state, agentDir, false)
    for (const sub of WATCHED_SUBDIRS) {
      addWatcher(state, join(agentDir, sub), false)
    }
  }
}

function listAgentDirsSafely(agentsDir: string): string[] {
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(agentsDir, entry.name))
  } catch {
    return []
  }
}

function armWatchers(state: RootWatch): void {
  const agentsDir = join(state.root.path, AGENTS_SUBDIR)
  state.recursive = false
  if (addWatcher(state, agentsDir, true)) {
    state.recursive = true
    logger.debug('watching a root recursively', { rootId: state.root.id })
    return
  }
  armFallbackWatchers(state)
  if (state.watchers.length === 0) {
    logger.warn('no watcher could be attached to this root', { rootId: state.root.id })
  }
}

export const watcherService = {
  /** Wire the scanner in. Called once, from the feature's composition root. */
  configure(next: WatcherDeps): void {
    deps = next
    if (!quitHookInstalled) {
      quitHookInstalled = true
      try {
        app.on('will-quit', () => watcherService.stopAll())
      } catch {
        // No Electron `app` (unit tests). `stopAll` is still callable directly.
      }
    }
  },

  /** Start watching a root. Idempotent per root id. */
  watchRoot(root: AgentRootRow): void {
    if (!deps) {
      logger.warn('watcher used before it was configured', { rootId: root.id })
      return
    }
    const existing = watches.get(root.id)
    if (existing) {
      // The path may have moved (the home setting changed); re-arm on the new one.
      if (existing.root.path === root.path) return
      this.unwatchRoot(root.id)
    }
    const state: RootWatch = {
      root,
      watchers: [],
      pending: new Set(),
      pendingWholeRoot: false,
      timer: null,
      recursive: false,
      rearmed: false,
      closed: false
    }
    watches.set(root.id, state)
    armWatchers(state)
  },

  /**
   * Re-arm the per-directory fallback for a root after its agent set changed.
   * A no-op where the recursive watcher is in use.
   */
  refreshRoot(rootId: string): void {
    const state = watches.get(rootId)
    if (!state || state.closed || state.recursive) return
    armFallbackWatchers(state)
  },

  /** Stop watching one root — it was removed, or its path moved. */
  unwatchRoot(rootId: string): void {
    const state = watches.get(rootId)
    if (!state) return
    state.closed = true
    if (state.timer) clearTimeout(state.timer)
    closeWatchers(state)
    watches.delete(rootId)
    logger.debug('stopped watching a root', { rootId })
  },

  /** Close every watcher. Runs on `will-quit`, and between tests. */
  stopAll(): void {
    for (const rootId of [...watches.keys()]) this.unwatchRoot(rootId)
  },

  /** Root ids currently watched. For diagnostics and tests. */
  watchedRootIds(): string[] {
    return [...watches.keys()]
  }
}
