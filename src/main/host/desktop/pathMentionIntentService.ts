/**
 * Files and folders handed to Cinna from Finder ("Mention in Cinna"), from the
 * OS to the renderer.
 *
 * ## Where they come from
 *
 * The Quick Action runs `open -b <bundle id> <paths…>`, and macOS delivers each
 * path as its own `open-file` event — several in a burst for a multi-selection,
 * and before `ready` on a cold launch, which is why `index.ts` installs the hook
 * at module scope. The E2E suite enters the same funnel with
 * `--cinna-mention-path=` (startup argv) or by emitting `open-file` on `app`.
 *
 * ## How much is believed
 *
 * Any process can run `open` with any argument, so each path is **untrusted**:
 * a string, absolute, at most 4096 characters, no NUL or control characters,
 * `realpath` succeeds and `stat` says file or folder. Anything else is dropped
 * with a debug line. Nothing is read; only the realpath is kept. A mention can
 * do no more than put a chip in the composer the user then decides to send.
 *
 * ## Buffered, merged
 *
 * Unlike the connect deep link (where the latest click replaces the previous
 * one), paths accumulate: a burst is one selection. The buffer dedups by
 * realpath and holds at most {@link MAX_BUFFERED_PATHS}. Once a burst settles
 * ({@link DEBOUNCE_MS}), the window is raised and told something is waiting;
 * the renderer pulls with `take()`, which resolves the paths against the
 * profile active *then* (core: `pathMentionService`). While no profile is
 * activated `take()` leaves the buffer alone; once one is ready the push is
 * sent again ({@link PathMentionIntentService.profileReady}, subscribed by the
 * composition root in `index.ts`), so a renderer that asked too early asks
 * once more.
 */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { createLogger } from '../../logger/logger'
import { ensureMainWindow, focusMainWindow } from '../../window/focus'
import { pathMentionService } from '../../services/localAgents/pathMentionService'
import { userActivation } from '../../auth/activation'
import { getCurrentUserId } from '../../auth/session'
import {
  MAX_MENTION_PATH_LENGTH,
  PATH_MENTION_ARGV_FLAG,
  PATH_MENTION_CHANNEL,
  mentionPathProblem,
  type ComposerPathRefKind,
  type PathMentionTake
} from '../../../shared/pathMentions'

const logger = createLogger('path-mention')

export { MAX_MENTION_PATH_LENGTH }
export const MAX_BUFFERED_PATHS = 20
export const DEBOUNCE_MS = 150

export type PathMentionSource = 'open-file' | 'test-argv'

export interface ValidatedMentionPath {
  path: string
  kind: ComposerPathRefKind
}

export interface MentionFs {
  realpath(path: string): Promise<string>
  kind(path: string): Promise<ComposerPathRefKind | null>
}

const nodeFs: MentionFs = {
  realpath: (path) => realpath(path),
  async kind(path) {
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
  }
}

/** The path's realpath and kind, or null (with the reason logged) when it is refused. */
export async function validateMentionPath(raw: unknown, fs: MentionFs = nodeFs): Promise<ValidatedMentionPath | null> {
  const refuse = (reason: string): null => {
    logger.debug('ignored a mentioned path', { reason })
    return null
  }
  if (typeof raw !== 'string' || raw.length === 0) return refuse('not a string')
  const problem = mentionPathProblem(raw)
  if (problem) return refuse(problem)
  if (!isAbsolute(raw)) return refuse('not absolute')
  let real: string
  try {
    real = await fs.realpath(raw)
  } catch {
    return refuse('does not exist')
  }
  // A symlink can resolve to a name the raw path's checks never saw.
  const realProblem = mentionPathProblem(real)
  if (realProblem) return refuse(`realpath: ${realProblem}`)
  let kind: ComposerPathRefKind | null
  try {
    kind = await fs.kind(real)
  } catch {
    return refuse('cannot be stat-ed')
  }
  if (!kind) return refuse('neither a file nor a folder')
  return { path: real, kind }
}

/** Every `--cinna-mention-path=` value in an argv, in order. */
export function mentionPathsFromArgv(argv: readonly string[]): string[] {
  return argv
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith(PATH_MENTION_ARGV_FLAG))
    .map((arg) => arg.slice(PATH_MENTION_ARGV_FLAG.length))
}

export interface PathMentionIntentDeps {
  fs: MentionFs
  /** Whether a window may be created now (the app is ready). */
  isReady(): boolean
  /** Raise the main window, creating it when the user had closed it; null when there is none. */
  showWindow(): Promise<BrowserWindow | null>
  resolve(paths: readonly string[], profileUserId: string): Promise<PathMentionTake>
  /** The profile a take resolves against, or null while none is activated (login, lock, a profile switch). */
  activeProfile(): string | null
  debounceMs: number
}

export type PathMentionIntentService = ReturnType<typeof createPathMentionIntentService>

export function createPathMentionIntentService(deps: PathMentionIntentDeps) {
  let buffer: string[] = []
  // Validation is async; chaining keeps a burst in the order it arrived.
  let chain: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, deps.debounceMs)
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0 || !deps.isReady()) return
    try {
      const win = await deps.showWindow()
      if (!win || win.isDestroyed()) return
      win.webContents.send(PATH_MENTION_CHANNEL)
    } catch (err) {
      logger.warn('could not announce mentioned paths', { error: String(err) })
    }
  }

  async function add(raw: unknown, source: PathMentionSource): Promise<void> {
    const valid = await validateMentionPath(raw, deps.fs)
    if (!valid) return
    if (buffer.includes(valid.path)) return
    if (buffer.length >= MAX_BUFFERED_PATHS) {
      logger.debug('ignored a mentioned path', { reason: 'buffer full' })
      return
    }
    buffer.push(valid.path)
    logger.info('path mention received', { source, kind: valid.kind })
    schedule()
  }

  return {
    /** The single funnel: `open-file`, the startup argv scan, and the test flag. Resolves once this path is handled. */
    deliver(raw: unknown, source: PathMentionSource): Promise<void> {
      chain = chain.then(() => add(raw, source)).catch((err) => {
        logger.warn('a mentioned path could not be handled', { error: String(err) })
      })
      return chain
    },

    /**
     * Drain the buffer, resolved against the active profile. Before activation
     * (login, locked, mid-switch) the buffer is left alone, not drained: the
     * push on profile-ready, or the signed-in shell's mount, asks again.
     */
    async take(): Promise<PathMentionTake> {
      const profileUserId = deps.activeProfile()
      if (!profileUserId) return { refs: [], agentId: null, agentMatch: null }
      const paths = buffer
      buffer = []
      if (paths.length === 0) return { refs: [], agentId: null, agentMatch: null }
      return deps.resolve(paths, profileUserId)
    },

    /**
     * A profile became usable (`userActivation.onProfileReady`, subscribed by
     * the composition root). A push that arrived while no profile was
     * activated found `take()` empty, and a renderer that stays mounted
     * through a profile switch or re-auth has no other reason to ask again:
     * tell it once more when paths are still waiting.
     */
    profileReady(): void {
      if (buffer.length > 0) void flush()
    },

    /** Test seam: what is buffered now. */
    pending(): readonly string[] {
      return buffer
    },

    /** Test seam: forget everything. */
    reset(): void {
      buffer = []
      chain = Promise.resolve()
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

export const pathMentionIntentService = createPathMentionIntentService({
  fs: nodeFs,
  isReady: () => app.isReady(),
  async showWindow() {
    const win = await ensureMainWindow()
    focusMainWindow()
    return win
  },
  resolve: (paths, profileUserId) => pathMentionService.resolve(paths, profileUserId),
  activeProfile: () => (userActivation.isActivated() ? getCurrentUserId() : null),
  debounceMs: DEBOUNCE_MS
})
