import { execFile } from 'node:child_process'
import type { CodexAuthStatus } from '../../../../shared/engine'
import { createLogger } from '../../../logger/logger'

const UNKNOWN: CodexAuthStatus = { state: 'unknown' }
const logger = createLogger('codex-auth')

/** The CLI prints login status on stderr, including when it exits 1 logged out. */
export function parseCodexAuthStatus(output: string): CodexAuthStatus {
  if (/^Logged in (using|with)\b/im.test(output.trim())) return { state: 'logged_in' }
  if (/^Not logged in\s*$/im.test(output.trim())) return { state: 'logged_out' }
  return UNKNOWN
}

export function probeCodexAuth(input: {
  path: string
  env: Record<string, string>
  exec?: typeof execFile
  timeoutMs?: number
}): Promise<CodexAuthStatus> {
  return new Promise((resolve) => {
    const timeoutMs = input.timeoutMs ?? 5000
    const startedAt = Date.now()
    let settled = false
    const finish = (status: CodexAuthStatus, reason?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const details = { state: status.state, reason, durationMs: Date.now() - startedAt }
      if (status.state === 'unknown') logger.warn('Codex login probe gave no usable verdict', details)
      else logger.debug('Codex login probe completed', details)
      resolve(status)
    }
    const timer = setTimeout(() => finish(UNKNOWN, 'timeout'), timeoutMs + 500)
    timer.unref?.()
    try {
      (input.exec ?? execFile)(input.path, ['login', 'status'], {
        env: input.env, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
        maxBuffer: 64 * 1024
      }, (error, stdout, stderr) => {
        // Never retain or log output: some CLI versions include API-key details.
        const status = error?.killed ? UNKNOWN : parseCodexAuthStatus(`${stdout}\n${stderr}`)
        finish(status, status.state === 'unknown' ? (error?.killed ? 'timeout' : 'unrecognized-response') : undefined)
      })
    } catch {
      finish(UNKNOWN, 'spawn-failed')
    }
  })
}

/** Shared, bounded and refreshable across readiness, turns and the renderer. */
export class CodexAuthProbe {
  private cached: { at: number; value: CodexAuthStatus } | null = null
  private inFlight: Promise<CodexAuthStatus> | null = null
  /** Bumped by {@link invalidate}: an answer asked of an earlier binary is neither shared nor kept. */
  private generation = 0

  constructor(private readonly deps: {
    path(): Promise<string | null>
    env(): Promise<Record<string, string>>
    probe?: typeof probeCodexAuth
    now?: () => number
  }) {}

  status(): Promise<CodexAuthStatus> {
    if (this.inFlight) return this.inFlight
    const now = (this.deps.now ?? Date.now)()
    if (this.cached && now - this.cached.at < 30_000) return Promise.resolve(this.cached.value)
    const generation = this.generation
    const run: Promise<CodexAuthStatus> = this.ask().catch(() => {
      logger.warn('Codex login probe inputs could not be prepared')
      return { value: UNKNOWN, asked: false }
    }).then(({ value, asked }) => {
      // **"There was nothing to ask" is not an answer worth keeping.** The
      // managed CLI is downloaded by the first turn that needs it, so a probe
      // taken a moment before that install would otherwise hold `unknown` for
      // thirty seconds — long enough for the launcher to skip the logged-out
      // refusal on the very turn that installed the binary.
      if (asked && generation === this.generation) this.cached = { at: (this.deps.now ?? Date.now)(), value }
      return value
    }).finally(() => { if (this.inFlight === run) this.inFlight = null })
    this.inFlight = run
    return run
  }

  /**
   * Forget the answer **without asking again** — the binary it was asked of is
   * no longer the one in use (the Codex Path in Settings changed). The cache
   * holds for thirty seconds whatever the path, so without this the Runtime row
   * and the picker go on describing the old CLI's login. Not `refresh`: the new
   * path may still be resolving, and "nothing to ask" is answered on demand.
   * A probe already in flight finishes for its own caller and is dropped.
   */
  invalidate(): void {
    this.generation++
    this.cached = null
    this.inFlight = null
  }

  refresh(): Promise<CodexAuthStatus> {
    this.cached = null
    return this.status()
  }

  private async ask(): Promise<{ value: CodexAuthStatus; asked: boolean }> {
    const path = await this.deps.path()
    if (!path) return { value: UNKNOWN, asked: false }
    return { value: await (this.deps.probe ?? probeCodexAuth)({ path, env: await this.deps.env() }), asked: true }
  }
}
