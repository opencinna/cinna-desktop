/**
 * Whether the user's Antigravity home is signed in — without starting the
 * server, which would open a browser sign-in by itself when the token is gone.
 *
 * Two facts, both read where the server keeps them:
 *
 * - `<home>/antigravity-acp/settings.json` names an `auth.type`. Without one a
 *   session refuses with "Authentication required".
 * - The Google token exists. On macOS it is the login keychain item (service
 *   `gemini`, account `antigravity-acp`), shared by every home; elsewhere the
 *   file `<home>/antigravity-acp/acp_token.json`.
 *
 * The keychain is asked with `security find-generic-password` **without `-w`**:
 * attributes only, which needs no keychain prompt, and its output is drained
 * and never read — the exit code is the answer (0 present, 44 not found). The
 * token file is only `stat`ed. Nothing here ever holds a token.
 *
 * `unknown` is a real answer, as for Codex: a settings file that will not parse,
 * a `security` that timed out, a platform with no known store.
 */

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AntigravityAuthStatus } from '../../../../shared/engine'
import { createLogger } from '../../../logger/logger'
import { antigravityHome } from './antigravityEnv'

const UNKNOWN: AntigravityAuthStatus = { state: 'unknown' }
const LOGGED_OUT: AntigravityAuthStatus = { state: 'logged_out' }
const LOGGED_IN: AntigravityAuthStatus = { state: 'logged_in' }
const logger = createLogger('antigravity-auth')

/** The keychain item the server stores its personal Google token under. */
export const ANTIGRAVITY_KEYCHAIN = { service: 'gemini', account: 'antigravity-acp' } as const

/** `security`'s exit code for "The specified item could not be found in the keychain." */
const SECURITY_ITEM_NOT_FOUND = 44

export interface AntigravityAuthProbeInput {
  /** The child environment: only its `GEMINI_HOME` is read. */
  env: Record<string, string>
  platform?: NodeJS.Platform
  /** The user's home directory, for `~/.gemini`. */
  homeDir?: string
  exec?: typeof execFile
  readFile?: (path: string) => Promise<string>
  /** Whether a regular file is at `path`. */
  fileExists?: (path: string) => Promise<boolean>
  timeoutMs?: number
}

/** The `auth.type` a settings file names, `null` when it names none, `undefined` when it cannot be read as JSON. */
export function parseAntigravityAuthType(text: string): string | null | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const auth = (parsed as { auth?: unknown }).auth
    const type = auth && typeof auth === 'object' ? (auth as { type?: unknown }).type : undefined
    return typeof type === 'string' && type.trim() !== '' ? type : null
  } catch {
    return undefined
  }
}

const defaultFileExists = (path: string): Promise<boolean> =>
  stat(path).then((info) => info.isFile(), () => false)

/** Exit 0 → present, 44 → absent, anything else (or a timeout) → cannot tell. Output never read. */
function keychainHasToken(input: AntigravityAuthProbeInput): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timeoutMs = input.timeoutMs ?? 5000
    let settled = false
    const finish = (value: boolean | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs + 500)
    timer.unref?.()
    try {
      (input.exec ?? execFile)(
        'security',
        ['find-generic-password', '-s', ANTIGRAVITY_KEYCHAIN.service, '-a', ANTIGRAVITY_KEYCHAIN.account],
        { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024 },
        // The attributes it prints are dropped here, unread.
        (error) => {
          if (!error) return finish(true)
          if (error.killed) return finish(null)
          return finish(error.code === SECURITY_ITEM_NOT_FOUND ? false : null)
        }
      )
    } catch {
      finish(null)
    }
  })
}

export async function probeAntigravityAuth(input: AntigravityAuthProbeInput): Promise<AntigravityAuthStatus> {
  const startedAt = Date.now()
  const platform = input.platform ?? process.platform
  const dir = join(antigravityHome(input.env, input.homeDir), 'antigravity-acp')
  const done = (status: AntigravityAuthStatus, reason?: string): AntigravityAuthStatus => {
    const details = { state: status.state, reason, durationMs: Date.now() - startedAt }
    if (status.state === 'unknown') logger.warn('Antigravity login probe gave no usable verdict', details)
    else logger.debug('Antigravity login probe completed', details)
    return status
  }

  let settings: string
  try {
    settings = await (input.readFile ?? ((path: string) => readFile(path, 'utf8')))(join(dir, 'settings.json'))
  } catch (error) {
    // Absent is an answer (never signed in, or signed out); unreadable is not.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return done(LOGGED_OUT, 'no-settings')
    return done(UNKNOWN, 'settings-unreadable')
  }
  const authType = parseAntigravityAuthType(settings)
  if (authType === undefined) return done(UNKNOWN, 'settings-unparsable')
  if (authType === null) return done(LOGGED_OUT, 'no-auth-type')

  if (platform === 'darwin') {
    const present = await keychainHasToken(input)
    if (present === null) return done(UNKNOWN, 'keychain-unanswered')
    return done(present ? LOGGED_IN : LOGGED_OUT, present ? undefined : 'no-token')
  }
  if (platform === 'linux') {
    const present = await (input.fileExists ?? defaultFileExists)(join(dir, 'acp_token.json'))
    return done(present ? LOGGED_IN : LOGGED_OUT, present ? undefined : 'no-token')
  }
  return done(UNKNOWN, 'unsupported-platform')
}

/**
 * Shared, bounded and refreshable across readiness, turns and the renderer —
 * {@link CodexAuthProbe}'s shape. There is always something to ask (no binary
 * is involved), so every answer is kept for thirty seconds.
 */
export class AntigravityAuthProbe {
  private cached: { at: number; value: AntigravityAuthStatus } | null = null
  private inFlight: Promise<AntigravityAuthStatus> | null = null
  /** Bumped by {@link invalidate}: an answer asked before it is neither shared nor kept. */
  private generation = 0

  constructor(private readonly deps: {
    env(): Promise<Record<string, string>>
    probe?: typeof probeAntigravityAuth
    now?: () => number
  }) {}

  status(): Promise<AntigravityAuthStatus> {
    if (this.inFlight) return this.inFlight
    const now = (this.deps.now ?? Date.now)()
    if (this.cached && now - this.cached.at < 30_000) return Promise.resolve(this.cached.value)
    const generation = this.generation
    const run: Promise<AntigravityAuthStatus> = this.ask().then(
      (value) => {
        if (generation === this.generation) this.cached = { at: (this.deps.now ?? Date.now)(), value }
        return value
      },
      () => {
        logger.warn('Antigravity login probe inputs could not be prepared')
        return UNKNOWN
      }
    ).finally(() => { if (this.inFlight === run) this.inFlight = null })
    this.inFlight = run
    return run
  }

  /**
   * Forget the answer without asking again — a login just ran, or the server
   * path changed. A probe already in flight finishes for its own caller and is
   * dropped.
   */
  invalidate(): void {
    this.generation++
    this.cached = null
    this.inFlight = null
  }

  refresh(): Promise<AntigravityAuthStatus> {
    this.cached = null
    return this.status()
  }

  private async ask(): Promise<AntigravityAuthStatus> {
    return (this.deps.probe ?? probeAntigravityAuth)({ env: await this.deps.env() })
  }
}
