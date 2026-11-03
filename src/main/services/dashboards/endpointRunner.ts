/**
 * A dashboard component's endpoint, run once: `dashboards/<name>/api/<script>`
 * in the agent folder, the params JSON on stdin, one JSON value on stdout
 * (README §5.3, core's webapp data-API convention).
 *
 * The subprocess is `commandService`'s `execute` — the shell, the process-group
 * kill on timeout or abort, the managed uv, the credential env — with what an
 * endpoint adds: stdin, a 5 MB stdout cap, a 2,000-character stderr tail.
 *
 * - **Runtime by extension.** `.py` → `python <script>` localized as `/run:`
 *   commands are (`uv run` beside a `pyproject.toml`). `.js`/`.mjs`/`.cjs` →
 *   the user's `node` when one resolves on the child's `PATH`; otherwise
 *   Cinna's own runtime as Node (`runtimeHost.nodeRuntime()`, the executable
 *   single-quoted — runs go through a shell and the app path has spaces —
 *   with `ELECTRON_RUN_AS_NODE=1`). The fallback runs pure JS only; a native
 *   addon fails with a sentence that says so.
 * - **The turn lock, yielding.** Held shared with owner `'dashboard'` through
 *   {@link turnLock.tryAcquireSharedYielding}: refused while an exclusive
 *   folder write is held or queued, which comes back `busy` (the tile keeps
 *   its data and skips the tick). Taken only once a slot is free, so a queued
 *   run never holds an editor save out. The hold is preemptible: an editor
 *   save, sharing verb or delete arriving mid-run aborts the run (its process
 *   group is killed) and proceeds; the run comes back `interrupted`.
 * - **At most three processes** across every dashboard, the rest queued.
 * - **The newest call per key wins.** A second call with the same key (tile
 *   and endpoint) aborts the first, queued or running.
 * - **Output is data.** stdout is parsed, then its string values are redacted
 *   (redacting the raw text first could break the JSON).
 *
 * Core module: no Electron.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getLayoutView } from '../../kit/contractStore'
import { runtimeHost } from '../../host/runtimeHost'
import { createLogger } from '../../logger/logger'
import { resolveOnEnvPath } from '../../shell/managedUvPath'
import { redactCredentialText, redactCredentialValues } from '../../security/serviceCredentialRedaction'
import { agentCommandEnv, executeLocalCommand, type ExecuteOptions } from '../localAgents/commandService'
import { turnLock, type TurnLockHandle } from '../localAgents/turnLock'
import { uvUnavailableReason } from '../localAgents/uvPrewarm'
import type { ScheduleCommandOutcome } from '../../../shared/localSchedules'
import { ENDPOINT_TIMEOUT_DEFAULT_S, ENDPOINT_TIMEOUT_MAX_S, type EndpointRuntime } from '../../kit/dashboardsProtocol'

const logger = createLogger('dashboard-endpoint')

/** stdout cap per call. */
export const MAX_ENDPOINT_STDOUT_BYTES = 5 * 1024 * 1024
/** How much of stderr a failure keeps. */
export const ENDPOINT_STDERR_TAIL_CHARS = 2000
/** Dashboard processes running at once, across every agent. */
export const MAX_CONCURRENT_ENDPOINTS = 3
/** The lock owner a dashboard run takes. */
export const DASHBOARD_LOCK_OWNER = 'dashboard'

export const NATIVE_ADDON_MESSAGE = 'This endpoint needs a native Node module; install Node to run it.'

export type EndpointFailureCode = 'busy' | 'superseded' | 'cancelled' | 'interrupted' | 'timeout' | 'failed' | 'too_large' | 'not_json'

/** What a run stopped by an exclusive folder write (an editor save) answers. */
export const INTERRUPTED_MESSAGE = 'A change to the agent’s folder interrupted this run; run it again.'

export type EndpointOutcome =
  | { ok: true; value: unknown; durationMs: number }
  | { ok: false; code: EndpointFailureCode; message: string; durationMs: number }

export interface EndpointCall {
  agentId: string
  /** Absolute agent folder: the cwd. */
  agentDir: string
  /** The agent's root, for the kit layout. */
  rootPath?: string
  /** Agent-relative script path (`dashboards/<name>/api/<file>`), already validated; quoted when run. */
  script: string
  runtime: EndpointRuntime
  params: unknown
  timeoutS?: number
  /** Calls with the same key supersede each other: a tile and endpoint. */
  key: string
  /** Aborts this call (a profile switch). */
  signal?: AbortSignal
}

export interface EndpointRunnerDeps {
  execute: (command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number, options: ExecuteOptions) => Promise<ScheduleCommandOutcome>
  childEnv: (agentId: string) => Promise<NodeJS.ProcessEnv>
  /** `python <script>` as the agent's commands run it. */
  localizePython: (command: string, agentDir: string, rootPath?: string) => string
  /** The `node` a child given `env` would run, or null. */
  resolveNode: (env: NodeJS.ProcessEnv) => Promise<string | null>
  nodeRuntime: () => { command: string; args: string[]; env: Record<string, string> }
  /** The yielding lock; `onPreempt` must stop the run (an exclusive folder write takes the agent). */
  tryLock: (agentId: string, onPreempt: () => void) => TurnLockHandle | null
  uvReason: (command: string, outcome: { exitCode: number | null; stderr?: string | null }) => Promise<string | null>
  maxConcurrent?: number
}

/** `'…'` for a POSIX shell, inner quotes escaped. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function clampTimeout(timeoutS: number | undefined): number {
  const s = typeof timeoutS === 'number' && Number.isFinite(timeoutS) ? Math.round(timeoutS) : ENDPOINT_TIMEOUT_DEFAULT_S
  return Math.min(Math.max(s, 1), ENDPOINT_TIMEOUT_MAX_S) * 1000
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim()
  return trimmed.length > ENDPOINT_STDERR_TAIL_CHARS ? trimmed.slice(-ENDPOINT_STDERR_TAIL_CHARS) : trimmed
}

export function createEndpointRunner(deps: EndpointRunnerDeps) {
  const maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT_ENDPOINTS
  let running = 0
  const queue: Array<() => void> = []
  const latest = new Map<string, AbortController>()

  function acquireSlot(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    if (running < maxConcurrent) {
      running++
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const start = (): void => {
        signal.removeEventListener('abort', abort)
        running++
        resolve(true)
      }
      const abort = (): void => {
        const at = queue.indexOf(start)
        if (at >= 0) queue.splice(at, 1)
        resolve(false)
      }
      queue.push(start)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  function releaseSlot(): void {
    running--
    const next = queue.shift()
    if (next) next()
  }

  async function command(call: EndpointCall, env: NodeJS.ProcessEnv): Promise<{ command: string; env: NodeJS.ProcessEnv; fallback: boolean }> {
    // Quoted: the schema lets a script path hold any character but a backslash.
    const script = shellQuote(call.script)
    if (call.runtime === 'python') {
      return { command: deps.localizePython(`python ${script}`, call.agentDir, call.rootPath), env, fallback: false }
    }
    if (await deps.resolveNode(env)) return { command: `node ${script}`, env, fallback: false }
    const runtime = deps.nodeRuntime()
    const parts = [runtime.command, ...runtime.args].map(shellQuote)
    return {
      command: `${parts.join(' ')} ${script}`,
      env: { ...env, ...runtime.env, ELECTRON_RUN_AS_NODE: '1' },
      fallback: true
    }
  }

  async function failureMessage(localCommand: string, outcome: ScheduleCommandOutcome, fallback: boolean, timeoutMs: number): Promise<{ code: EndpointFailureCode; message: string }> {
    if (outcome.spawnError) return { code: 'failed', message: `The endpoint could not start: ${redactCredentialText(outcome.spawnError)}` }
    if (outcome.timedOut) return { code: 'timeout', message: `The endpoint did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.` }
    const tail = stderrTail(redactCredentialText(outcome.stderr))
    if (fallback && /NODE_MODULE_VERSION|code signature/.test(outcome.stderr)) return { code: 'failed', message: NATIVE_ADDON_MESSAGE }
    const uv = await deps.uvReason(localCommand, outcome).catch(() => null)
    if (uv) return { code: 'failed', message: uv }
    return { code: 'failed', message: tail ? `The endpoint exited with code ${outcome.exitCode}: ${tail}` : `The endpoint exited with code ${outcome.exitCode}.` }
  }

  async function run(call: EndpointCall): Promise<EndpointOutcome> {
    const startedAt = Date.now()
    const done = (o: { ok: false; code: EndpointFailureCode; message: string }): EndpointOutcome => ({ ...o, durationMs: Date.now() - startedAt })

    // The newest call for this key wins: the older one is aborted, queued or running.
    latest.get(call.key)?.abort()
    const controller = new AbortController()
    latest.set(call.key, controller)
    const outer = call.signal
    const onOuterAbort = (): void => controller.abort()
    if (outer?.aborted) controller.abort()
    outer?.addEventListener('abort', onOuterAbort, { once: true })
    const signal = controller.signal
    let preempted = false
    const aborted = (): EndpointOutcome =>
      done(outer?.aborted ? { ok: false, code: 'cancelled', message: 'The run was cancelled.' }
        : preempted ? { ok: false, code: 'interrupted', message: INTERRUPTED_MESSAGE }
          : { ok: false, code: 'superseded', message: 'A newer run replaced this one.' })

    try {
      if (!(await acquireSlot(signal))) return aborted()
      try {
        if (signal.aborted) return aborted()
        const lock = deps.tryLock(call.agentId, () => {
          preempted = true
          controller.abort()
        })
        if (!lock) {
          logger.debug('endpoint deferred: agent busy', { agentId: call.agentId })
          return done({ ok: false, code: 'busy', message: 'The agent is busy; the tile keeps its data.' })
        }
        try {
          const baseEnv = await deps.childEnv(call.agentId)
          const { command: localCommand, env, fallback } = await command(call, baseEnv)
          const timeoutMs = clampTimeout(call.timeoutS)
          const outcome = await deps.execute(localCommand, call.agentDir, env, signal, timeoutMs, {
            stdin: JSON.stringify(call.params ?? {}),
            maxStdoutBytes: MAX_ENDPOINT_STDOUT_BYTES,
            stderrTailBytes: ENDPOINT_STDERR_TAIL_CHARS * 4
          })
          if ((outcome.aborted && !outcome.timedOut) || preempted) return aborted()
          if (outcome.spawnError || outcome.timedOut || outcome.exitCode !== 0) {
            return done({ ok: false, ...(await failureMessage(localCommand, outcome, fallback, timeoutMs)) })
          }
          if (outcome.stdoutTruncated) return done({ ok: false, code: 'too_large', message: 'The endpoint’s output is too large (over 5 MB).' })
          let value: unknown
          try {
            value = JSON.parse(outcome.stdout)
          } catch {
            return done({ ok: false, code: 'not_json', message: 'The endpoint did not print one JSON value on stdout.' })
          }
          return { ok: true, value: redactCredentialValues(value), durationMs: Date.now() - startedAt }
        } finally {
          lock.release()
        }
      } finally {
        releaseSlot()
      }
    } catch (err) {
      logger.warn('endpoint run failed', { agentId: call.agentId, error: err instanceof Error ? err.message : String(err) })
      return done({ ok: false, code: 'failed', message: 'The endpoint could not run.' })
    } finally {
      outer?.removeEventListener('abort', onOuterAbort)
      if (latest.get(call.key) === controller) latest.delete(call.key)
    }
  }

  return {
    run,
    /** For tests: processes running now and calls waiting for a slot. */
    stats(): { running: number; queued: number } {
      return { running, queued: queue.length }
    }
  }
}

export type EndpointRunner = ReturnType<typeof createEndpointRunner>

/** The production runner: the real execute, env, layout and lock. */
export const endpointRunner = createEndpointRunner({
  execute: executeLocalCommand,
  childEnv: agentCommandEnv,
  localizePython: (localCommand, agentDir, rootPath) =>
    getLayoutView(rootPath).localizeCommand(localCommand, { hasPyproject: existsSync(join(agentDir, 'pyproject.toml')) }),
  resolveNode: (env) => resolveOnEnvPath('node', env),
  nodeRuntime: () => runtimeHost.nodeRuntime(),
  tryLock: (agentId, onPreempt) => turnLock.tryAcquireSharedYielding(agentId, DASHBOARD_LOCK_OWNER, onPreempt),
  uvReason: uvUnavailableReason
})
