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
    this.inFlight = this.ask().catch(() => {
      logger.warn('Codex login probe inputs could not be prepared')
      return UNKNOWN
    }).then((value) => {
      this.cached = { at: (this.deps.now ?? Date.now)(), value }
      return value
    }).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  refresh(): Promise<CodexAuthStatus> {
    this.cached = null
    return this.status()
  }

  private async ask(): Promise<CodexAuthStatus> {
    const path = await this.deps.path()
    return path ? (this.deps.probe ?? probeCodexAuth)({ path, env: await this.deps.env() }) : UNKNOWN
  }
}
