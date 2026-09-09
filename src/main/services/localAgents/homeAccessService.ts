/**
 * Whether the app may create the agents home, and the one place that first
 * creates it.
 *
 * ## The problem
 *
 * The home is `~/Documents/CinnaAgents`, and `~/Documents` is one of the
 * folders macOS guards. The first write there raises *"Cinna Desktop would like
 * to access files in your Documents folder"* — a system dialog with no
 * explanation of what the folder is for, arriving at whatever moment some
 * unrelated screen happened to ask where the agents live. People decline
 * dialogs they did not expect, and declining leaves the app with nowhere to put
 * an agent.
 *
 * So: **nothing writes to a guarded home until the user has been told what the
 * folder is.** {@link agentsHomeService.ensureHome} refuses with
 * `home_consent_required` while that is outstanding, which makes the rule
 * structural rather than a convention every new caller has to remember.
 *
 * ## Why the answer is ours and not the system's
 *
 * There is no way to ask macOS whether a prompt is pending. Electron exposes
 * permission state for the camera, the microphone and the screen, and nothing
 * for files. `TCC.db` needs Full Disk Access — a bigger prompt than the one
 * being avoided. The private preflight SPI is private. And any probe that
 * actually reads the folder *is* the trigger.
 *
 * What is left is our own record, and it is enough:
 *
 * * a home outside a guarded folder needs nothing said, on any platform;
 * * a home this install has a root row for, whose folder is still on disk, was
 *   created by a build that got the grant — the question is settled;
 * * otherwise the user has not been told, and we tell them.
 *
 * {@link state} does **no filesystem work on a fresh install**, which is the
 * half that has to be free: nothing names the folder, and the answer is pure
 * path work. Where a row does name it the answer costs one `stat` *of* the
 * folder — never a read *inside* it, which is what the prompt is about — and
 * only on an install that has been using that folder already.
 *
 * Neither half of that second rule stands alone. The row without the folder is
 * a database carried to another Mac by Migration Assistant; the folder without
 * the row is a `~/Documents` restored from a backup on a machine that has never
 * granted this app anything. Both have to agree before the question is settled.
 *
 * ## Refusal
 *
 * A refusal is not *persisted*. macOS remembers it and answers the next `mkdir`
 * with `EPERM` immediately — no prompt, no wait — so re-attempting costs one
 * failed syscall and works the moment the user flips the switch in System
 * Settings. A stored "denied" would go on reporting a problem they had already
 * fixed. It is held in memory for the life of the process instead, so that
 * every surface gets the same answer between the refusal and the next launch —
 * see {@link refusedPath}.
 */

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { agentRootRepo } from '../../db/agentRoots'
import { appSettingsRepo } from '../../db/appSettings'
import { createLogger } from '../../logger/logger'
import type { AgentsHomeState } from '../../../shared/localAgents'
import { configuredHomePath, isGuardedLocation } from './homePath'

const logger = createLogger('local-agents-home-access')

/** `{ "<path>": true }` for every home the user has had explained. */
function readAcknowledged(): Record<string, true> {
  const raw = appSettingsRepo.get('localAgentsHomeAcknowledged')
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, true> = {}
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[path] = true
    }
    return out
  } catch {
    // A corrupt value means "nobody has been told", which is the safe reading:
    // the worst case is explaining the folder once more.
    return {}
  }
}

/**
 * The home this process asked for and was told no about, if any.
 *
 * In memory, never on disk, and the **only** record of a refusal anywhere — see
 * the module note on why it is not persisted. It exists so that "is the folder
 * usable?" has one answer: without it `list` could only ever report
 * `needs_consent` after a refusal (nothing is acknowledged when macOS says no),
 * and the renderer had to keep a second, contradicting answer of its own.
 *
 * Cleared by any success, and gone at the next launch — which is what makes a
 * grant flipped on in System Settings take effect by restarting the app.
 */
let refusedPath: string | null = null

/**
 * True when the write into `path` would be this app's first, on a macOS that
 * will ask about it.
 *
 * `userId` is whichever scope the caller works in, and the two callers differ:
 * every local-agents channel is in the settings scope (`__default__`) while
 * local development passes the profile id. The acknowledgement below is
 * installation-global, so they agree once the question has been answered; only
 * the root-row shortcut is scope-sensitive, and answering "ask" for a scope
 * with no row is the safe direction.
 */
function mustExplain(userId: string, path: string): boolean {
  if (!isGuardedLocation(path)) return false
  if (readAcknowledged()[path]) return false
  // A registered root at this path, with the folder still there, is this
  // install having created it once — which on a guarded path took a grant.
  // This is what stops an existing install being asked about a folder it has
  // been using for months.
  //
  // The `existsSync` is the half that matters: a database carried to a new Mac
  // by Migration Assistant brings the row without the folder or the grant, and
  // the row alone would send `ensureHome` into a synchronous `mkdir` there —
  // the main thread frozen behind an unexplained prompt, which is the exact
  // failure this file exists to prevent. It is a `stat` of the folder, not a
  // read inside it, and it is only reached on an install that already has a
  // row; a fresh one answers with no filesystem work at all.
  //
  // It does not cover a `tccutil reset` that leaves the folder in place. That
  // one still prompts unexplained, once, for a user who knows the folder.
  return agentRootRepo.getByPath(userId, path) === undefined || !existsSync(path)
}

export const homeAccessService = {
  /**
   * Where the home is and whether it can be written to, **without touching the
   * disk**. Safe to call from anywhere, including before the user has answered
   * anything — which is the point, since the renderer needs the path to talk
   * about the folder it is asking permission to create.
   *
   * Never reports `denied`: a refusal is not stored (see the module note), so
   * the only thing that can report one is an attempt. {@link grant} does.
   */
  state(userId: string): AgentsHomeState {
    const path = configuredHomePath()
    return {
      path,
      guarded: isGuardedLocation(path),
      access:
        refusedPath === path ? 'denied' : mustExplain(userId, path) ? 'needs_consent' : 'ready'
    }
  },

  /** Whether this process has already been refused `path`. */
  refused(path: string): boolean {
    return refusedPath === path
  },

  /** Remember a refusal for the life of this process. */
  noteRefusal(path: string): void {
    refusedPath = path
  },

  /** Forget it, after any success. */
  clearRefusal(): void {
    refusedPath = null
  },

  /** Whether {@link agentsHomeService.ensureHome} must refuse to create. */
  mustAsk(userId: string): boolean {
    return mustExplain(userId, configuredHomePath())
  },

  /**
   * Record that the user has been told about `path`. Idempotent.
   *
   * Called by {@link grant}, which is also how local development reaches it —
   * through `agentsHomeService.prepare`, before it names the workspace folder.
   * Its own consent screen has already said where it will write, and being told
   * twice about the same folder in two modals is worse than being told once.
   */
  acknowledge(path: string): void {
    const current = readAcknowledged()
    if (current[path]) return
    appSettingsRepo.set('localAgentsHomeAcknowledged', JSON.stringify({ ...current, [path]: true }))
    logger.info('agents home acknowledged', { guarded: isGuardedLocation(path) })
  },

  /**
   * Create the home directory, taking the macOS prompt with it.
   *
   * **Asynchronously, and that is the reason this exists** rather than letting
   * `ensureHome`'s `mkdirSync` do it. The prompt blocks the calling thread until
   * the user answers it; synchronous `fs` on the main process means the window
   * stops redrawing and every other IPC call queues behind a dialog the user is
   * still reading. `fs/promises` puts the wait on a threadpool thread and leaves
   * the app alive underneath.
   *
   * Only the directory. Templates, `.cinna-kit/` and the root row are
   * `ensureHome`'s work, and they run afterwards with the grant already in hand
   * — so their synchronous writes never wait on anything.
   */
  async grant(): Promise<AgentsHomeState> {
    const path = configuredHomePath()
    const guarded = isGuardedLocation(path)
    try {
      await mkdir(path, { recursive: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        logger.warn('the agents home was refused by the system', { guarded, code })
        refusedPath = path
        return { path, guarded, access: 'denied' }
      }
      throw err
    }
    // After the write, not before: acknowledging a folder we then failed to
    // create would suppress the explanation on the next attempt.
    this.acknowledge(path)
    refusedPath = null
    return { path, guarded, access: 'ready' }
  }
}
