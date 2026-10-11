/**
 * The vendor's own login, run from the app — `claude auth login` or
 * `codex login` — with **the binary and child environment the turns use**.
 * Antigravity has no login CLI: its login is an ACP `authenticate` on its own
 * server, so that entry carries an {@link EngineLoginProtocol} that speaks to
 * the child over stdio, and everything else here — phases, cancel, timeout,
 * shutdown, the verdict — is the same.
 *
 * ## Why this exists
 *
 * The `claude` Cinna runs is usually its managed copy under `userData`, which
 * is not on PATH. Telling the user to "run `claude` in a terminal" pointed at a
 * binary that was not there, and a user who then installed a second Claude Code
 * by hand inherited PATH problems for nothing. The login follows `HOME`, not the
 * binary, so a login run here — under `buildClaudeEnv` / `buildCodexEnv` — is
 * exactly the one `auth status` and every turn will see.
 *
 * ## What the child does (measured against the pinned CLIs)
 *
 * Both print a line, open the browser themselves, listen on a loopback callback
 * port and wait; the browser sign-in completes them with nothing pasted. So the
 * child gets **no stdin** (`'ignore'`), and nothing here ever writes to it.
 * `claude auth login` also prints a fallback URL for a *paste-a-code* flow; that
 * URL is never surfaced. This app does not call `openExternal` either.
 *
 * ## What is never kept
 *
 * **stdout and stderr are drained and discarded** — not logged, not retained,
 * not returned. Codex can print key details; Claude prints the paste URL. The
 * log carries the engine, the outcome, the exit code and the duration.
 *
 * ## The verdict
 *
 * The exit code is logged and is not the answer. On every exit — success,
 * failure, cancel, timeout — the auth probe's cached answer is dropped and the
 * binary is asked again; `logged_in` iff that fresh answer says so. Hub core:
 * no Electron here, and a window unmounting does not end a login — only
 * {@link EngineLogin.cancel}, the timeout, or {@link EngineLogin.shutdown}.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createLogger } from '../../../logger/logger'
import type { EngineLoginId, EngineLoginPhase, EngineLoginResult } from '../../../../shared/engine'

/** States, exit codes and durations only — never the child's output. */
const logger = createLogger('engine-login')

/** How long a browser sign-in may take before the child is killed. */
export const ENGINE_LOGIN_TIMEOUT_MS = 10 * 60_000

/** SIGTERM first; SIGKILL if the child is still there after this. */
export const ENGINE_LOGIN_KILL_GRACE_MS = 3_000

/** The engines whose login is a CLI subcommand, and so has a terminal form. */
export type CliLoginId = Exclude<EngineLoginId, 'antigravity'>

/** The subcommand each engine's CLI logs in with. Nothing the renderer sends is appended. */
export const ENGINE_LOGIN_ARGS: Record<CliLoginId, readonly string[]> = {
  claude: ['auth', 'login'],
  codex: ['login']
}

/**
 * A login spoken **to** the child rather than one it runs by itself: the
 * child is started with {@link args} and stdin open, and {@link converse}
 * exchanges messages with it. When `converse` settles — the exchange has its
 * answer, good or bad — the child is stopped, and the verdict is the probe's
 * as for every login. `converse` reads stdout to find its answers and must
 * neither keep nor log what it reads.
 */
export interface EngineLoginProtocol {
  args: readonly string[]
  converse(child: ChildProcess): Promise<'answered' | 'refused'>
}

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface EngineLoginDeps {
  engine: EngineLoginId
  /**
   * The binary the turns run on — the Settings path, else the managed pin,
   * **downloading it if needed**. A failure is its user-facing sentence.
   */
  binary(): Promise<{ path: string } | { error: string }>
  /** The child environment the auth probe gets. Never `process.env`. */
  env(): Promise<Record<string, string>>
  /** Drop the probe's cached answer and ask the binary again. */
  refresh(): Promise<{ state: string }>
  /** Present for a login spoken over the child's stdio (Antigravity's ACP `authenticate`). */
  protocol?: EngineLoginProtocol
  spawn?: SpawnLike
  timeoutMs?: number
  killGraceMs?: number
  platform?: NodeJS.Platform
}

/** One argument quoted for the user's shell; POSIX single quotes, `cmd` double quotes on Windows. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The command the user can run in a terminal instead: the absolute binary,
 * quoted, then the fixed subcommand. Null for Antigravity, whose login is a
 * protocol exchange with no terminal form.
 */
export function engineLoginCommand(
  engine: EngineLoginId,
  path: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (engine === 'antigravity') return null
  return [shellQuote(path, platform), ...ENGINE_LOGIN_ARGS[engine]].join(' ')
}

type EndReason = 'exited' | 'cancelled' | 'shutdown' | 'timeout' | 'spawn-error'

type StopReason = 'cancelled' | 'shutdown'

interface Running {
  child: ChildProcess | null
  /** Set by cancel/shutdown before or after the spawn; decides the outcome on exit. */
  stop: StopReason | null
  /** `preparing` while the binary resolves (or downloads) and the env is built; `waiting` once the child runs. */
  phase: EngineLoginPhase
  /** The terminal command, once the binary is known. */
  command: string | null
  startedAt: number
  exited: Promise<void>
  markExited(): void
  /** Settle the login now — a stop before any child exists does not wait for the binary. */
  settleEarly(stop: StopReason): void
}

export class EngineLogin {
  private inFlight: Promise<EngineLoginResult> | null = null
  private current: Running | null = null

  constructor(private readonly deps: EngineLoginDeps) {}

  /**
   * Which phase a running login is in — `preparing` while its binary resolves
   * or downloads, `waiting` once the CLI runs and waits on the browser — or
   * null when none is running.
   */
  running(): EngineLoginPhase | null {
    if (!this.inFlight) return null
    return this.current?.phase ?? 'preparing'
  }

  /**
   * Start a login, or **join the one already running** — the port it listens
   * on is fixed for Codex, and two browser tabs for one sign-in help nobody.
   * Never rejects.
   *
   * A cancel (or shutdown) before the child exists settles it `cancelled` at
   * once: a download of the pinned binary can take minutes, and the user who
   * pressed Cancel is not waiting for it. That download then finishes on its
   * own and spawns nothing (the `stop` checks in {@link run}).
   */
  start(): Promise<EngineLoginResult> {
    if (this.inFlight) return this.inFlight
    let markExited!: () => void
    const exited = new Promise<void>((resolve) => { markExited = resolve })
    let settleEarly!: (result: EngineLoginResult) => void
    const early = new Promise<EngineLoginResult>((resolve) => { settleEarly = resolve })
    const current: Running = {
      child: null,
      stop: null,
      phase: 'preparing',
      command: null,
      startedAt: Date.now(),
      exited,
      markExited,
      settleEarly: (stop) => {
        logger.info('engine login finished', {
          engine: this.deps.engine,
          outcome: 'cancelled',
          end: stop,
          exitCode: null,
          durationMs: Date.now() - current.startedAt
        })
        current.markExited()
        // Nothing ran, so the probe's cached answer still stands: no refresh.
        settleEarly({ outcome: 'cancelled', command: current.command })
      }
    }
    this.current = current
    const run: Promise<EngineLoginResult> = Promise.race([this.run(current), early]).finally(() => {
      if (this.inFlight === run) this.inFlight = null
      if (this.current === current) this.current = null
    })
    this.inFlight = run
    return run
  }

  /** Stop the running login, if any. SIGTERM, then SIGKILL after a grace. */
  cancel(): boolean {
    return this.stop('cancelled')
  }

  /** App shutdown: kill any running login and resolve once it is gone (or after the grace). */
  shutdown(): Promise<void> {
    const current = this.current
    if (!this.stop('shutdown') || !current) return Promise.resolve()
    return current.exited
  }

  private stop(reason: StopReason): boolean {
    const current = this.current
    if (!current) return false
    // A shutdown outranks an earlier cancel: after it, nothing asks the probe.
    if (current.stop !== 'shutdown') current.stop = reason
    if (current.child) this.kill(current)
    else current.settleEarly(reason)
    return true
  }

  private kill(current: Running): void {
    const child = current.child
    if (!child) return
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    const grace = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      current.markExited()
    }, this.deps.killGraceMs ?? ENGINE_LOGIN_KILL_GRACE_MS)
    grace.unref?.()
    void current.exited.then(() => clearTimeout(grace))
  }

  /**
   * The login itself. After an early stop this keeps running detached until
   * its pending step returns, then stops without spawning; its result is
   * ignored (the race in {@link start} is already settled).
   */
  private async run(current: Running): Promise<EngineLoginResult> {
    const { engine } = this.deps
    const stopped = (): EngineLoginResult => ({ outcome: 'cancelled', command: current.command })
    try {
      const binary = await this.deps.binary().catch((): { error: string } => ({
        error: 'The engine could not be installed.'
      }))
      if (current.stop) return stopped()
      if ('error' in binary) {
        logger.warn('engine login could not resolve its binary', { engine })
        return { outcome: 'failed', command: null, reason: binary.error }
      }
      const command = this.deps.protocol ? null : engineLoginCommand(engine, binary.path, this.deps.platform)
      current.command = command

      let env: Record<string, string>
      try {
        env = await this.deps.env()
      } catch {
        if (current.stop) return stopped()
        logger.warn('engine login could not prepare its environment', { engine })
        return this.finish('spawn-error', command, current.startedAt, null)
      }
      if (current.stop) return stopped()

      const { reason, code } = await this.spawnAndWait(current, binary.path, env)
      return await this.finish(reason, command, current.startedAt, code)
    } finally {
      current.markExited()
    }
  }

  private spawnAndWait(
    current: Running,
    path: string,
    env: Record<string, string>
  ): Promise<{ reason: EndReason; code: number | null }> {
    const { engine } = this.deps
    return new Promise((resolve) => {
      let timedOut = false
      let settled = false
      const done = (reason: EndReason, code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        current.markExited()
        resolve({ reason, code })
      }
      const timer = setTimeout(() => {
        timedOut = true
        this.kill(current)
      }, this.deps.timeoutMs ?? ENGINE_LOGIN_TIMEOUT_MS)
      timer.unref?.()

      const protocol = this.deps.protocol
      const args = protocol ? protocol.args : engine === 'antigravity' ? null : ENGINE_LOGIN_ARGS[engine]
      if (!args) {
        done('spawn-error', null)
        return
      }
      let child: ChildProcess
      try {
        child = (this.deps.spawn ?? nodeSpawn)(path, args, {
          env,
          // A protocol login speaks on stdin; a CLI login is never written to.
          stdio: [protocol ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch {
        done('spawn-error', null)
        return
      }
      current.child = child
      current.phase = 'waiting'
      logger.info('engine login started', { engine })
      // Drained, never read: see the header. `resume()` discards the bytes.
      // A protocol login reads stdout for its answers instead, and keeps none.
      if (!protocol) child.stdout?.resume()
      child.stderr?.resume()
      if (protocol) {
        // The exchange has its answer: stop the child, and `exit` decides as
        // for a CLI that ended on its own. Its outcome is logged, not trusted.
        const answered = (result: 'answered' | 'refused' | 'broken'): void => {
          if (settled) return
          logger.info('engine login exchange ended', { engine, result })
          try { child.stdin?.end() } catch { /* already closed */ }
          this.kill(current)
        }
        protocol.converse(child).then(answered, () => answered('broken'))
      }
      // Terminal only when the child never started (ENOENT, EACCES). After a
      // spawn, an `error` is about an operation on a live child — a kill that
      // failed — and the login is still running: `exit` decides.
      let started = false
      child.on('spawn', () => { started = true })
      child.on('error', () => {
        if (started || child.pid !== undefined) return
        done('spawn-error', null)
      })
      // `exit`, not `close`: a grandchild holding the pipes open must not keep
      // the login pending after the CLI itself is gone.
      child.on('exit', (code) => {
        done(timedOut ? 'timeout' : current.stop ?? 'exited', code)
      })
      // Cancelled between the env and the spawn: kill what was just started.
      if (current.stop) this.kill(current)
    })
  }

  private async finish(
    reason: EndReason,
    command: string | null,
    startedAt: number,
    exitCode: number | null
  ): Promise<EngineLoginResult> {
    const { engine } = this.deps
    // Every exit, whatever the reason: the cached verdict is about the world
    // before this child ran. Except at app shutdown — nothing is left to read
    // the answer, and asking would spawn the binary while the app quits.
    const status = reason === 'shutdown' ? null : await this.deps.refresh().catch(() => null)
    const outcome: EngineLoginResult['outcome'] =
      status?.state === 'logged_in'
        ? 'logged_in'
        : reason === 'cancelled' || reason === 'shutdown'
          ? 'cancelled'
          : reason === 'timeout'
            ? 'timeout'
            : 'failed'
    logger.info('engine login finished', {
      engine,
      outcome,
      end: reason,
      exitCode,
      durationMs: Date.now() - startedAt
    })
    return { outcome, command }
  }
}
