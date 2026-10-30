/**
 * Pre-warm what a kit agent's `uv run` needs: the desktop's managed uv and the
 * Python the agent template asks for.
 *
 * Fired and forgotten when an agent is scaffolded and when a profile with local
 * agents becomes ready, so the first `/run:status` on a machine with no uv —
 * a fresh Mac without the command line developer tools, Homebrew or uv —
 * neither downloads for minutes nor stops at a missing interpreter.
 *
 * `uv python install` is run by the uv agent runs will use (the first on the
 * run env's `PATH`, which ends with the managed uv — see `managedUvPath.ts`),
 * in that same env, so the Python lands where runs look for it. With an agent
 * folder it runs there and reads its `.python-version`; without one it names
 * the version from the active contract's `templates/agent/.python-version`.
 *
 * Never throws to a caller. A failure to install the managed uv is kept in
 * {@link UvPrewarmState.failure}: it is what the "uv is not available" message
 * explains when a `uv …` command could not start — and that command starts
 * a new pre-warm, so "run it again" is true after a failure, and an agent
 * that arrived some other way (a clone, a folder added) still gets one.
 *
 * `CINNA_UV_PREWARM=off` turns it off (E2E: no test downloads uv or a Python).
 * `shutdown()` kills a running `uv python install` with the app.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError } from '../../errors'
import { readContractFile } from '../../kit/contractStore'
import { toolchain } from '../../localdev/toolchain'
import { createLogger } from '../../logger/logger'
import { redactCredentialText } from '../../security/serviceCredentialRedaction'
import { getShellEnv, shellEnvForChild } from '../../shell/env'
import {
  resolveOnEnvPath,
  uvCouldNotStart,
  uvUnavailableMessage,
  withManagedUvFallback,
  type UvInstallFailure
} from '../../shell/managedUvPath'

const logger = createLogger('uv-prewarm')

/** Ceiling on `uv python install`: a CPython download on a slow line. */
const PYTHON_INSTALL_TIMEOUT_MS = 10 * 60_000

/** The contract file naming the Python a new agent pins. */
export const TEMPLATE_PYTHON_VERSION_FILE = 'templates/agent/.python-version'

export type PrewarmStep = 'unknown' | 'installing' | 'ready' | 'failed'

export interface UvPrewarmState {
  uv: PrewarmStep
  python: PrewarmStep
  /** Why the managed uv could not be installed (a `ToolchainError` code and message). */
  failure?: UvInstallFailure
}

export interface UvPrewarmDeps {
  /** False under `CINNA_UV_PREWARM=off`. */
  enabled(): boolean
  /** Install the managed uv if it is not yet (`toolchain.ensureUv`). */
  ensureUv(): Promise<unknown>
  /** The environment agent runs get: login shell, narrowed, managed uv last on PATH. */
  runEnv(): Promise<NodeJS.ProcessEnv>
  /** The first `uv` on `env`'s PATH. */
  resolveUv(env: NodeJS.ProcessEnv): Promise<string | null>
  /** The template's Python version, or null when the contract has none. */
  contractPythonVersion(): string | null
  hasPythonVersionFile(agentDir: string): boolean
  run(bin: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd?: string }): Promise<{ code: number | null; stderr: string }>
  /** Kill every install `run` started. Synchronous. */
  killRuns(): void
  /** The clock the retry back-off reads; `Date.now` unless a test fakes it. */
  now?: () => number
}

/**
 * How long after a failed uv install a failing `uv …` command does not start
 * another: offline, a once-a-minute schedule would otherwise retry the download
 * every minute, and a proxy that fails the checksum would re-download it each time.
 */
export const RETRY_BACKOFF_MS = 5 * 60_000

export function createUvPrewarm(deps: UvPrewarmDeps) {
  let state: UvPrewarmState = { uv: 'unknown', python: 'unknown' }
  let inFlight: Promise<void> | null = null
  let closed = false
  let failedAt: number | null = null
  const now = deps.now ?? Date.now

  const set = (patch: Partial<UvPrewarmState>): void => {
    state = { ...state, ...patch }
    logger.info('uv pre-warm', { uv: state.uv, python: state.python, ...(state.failure ? { failure: state.failure.code } : {}) })
  }

  async function installUv(): Promise<void> {
    set({ uv: 'installing' })
    try {
      await deps.ensureUv()
      state = { ...state, failure: undefined }
      set({ uv: 'ready' })
    } catch (error) {
      const code = error instanceof DomainError ? String(error.code) : 'download_failed'
      const message = redactCredentialText(error instanceof Error ? error.message : String(error))
      failedAt = now()
      set({ uv: 'failed', failure: { code, message } })
    }
  }

  async function installPython(agentDir?: string): Promise<void> {
    set({ python: 'installing' })
    const env = await deps.runEnv()
    const uv = await deps.resolveUv(env)
    if (!uv) {
      logger.warn('no uv to install Python with')
      set({ python: 'failed' })
      return
    }
    let args: string[] = ['python', 'install']
    let cwd: string | undefined
    if (agentDir && deps.hasPythonVersionFile(agentDir)) {
      cwd = agentDir
    } else {
      const version = deps.contractPythonVersion()
      if (!version) {
        logger.warn('the agent contract names no Python version; nothing installed')
        set({ python: 'failed' })
        return
      }
      args = [...args, version]
      cwd = agentDir
    }
    // The app may have started quitting during the uv download or the PATH walk:
    // a child spawned now would miss shutdown's kill and outlive the app.
    if (closed) return
    const result = await deps.run(uv, args, { env, ...(cwd ? { cwd } : {}) })
    if (result.code === 0) {
      set({ python: 'ready' })
    } else {
      logger.warn('uv python install failed', { code: result.code, stderr: redactCredentialText(result.stderr.slice(-2000)) })
      set({ python: 'failed' })
    }
  }

  /** Whether a failing `uv …` command should start another pre-warm. */
  function shouldRetry(): boolean {
    if (state.uv === 'installing') return false
    // No build for this platform: a retry cannot change that.
    if (state.failure?.code === 'unsupported_platform') return false
    return failedAt === null || now() - failedAt >= RETRY_BACKOFF_MS
  }

  const api = {
    /**
     * Install the managed uv, then the agent's Python. Single-flight: a call
     * while one runs shares it. Resolves when done; never rejects.
     */
    prewarm(agentDir?: string): Promise<void> {
      if (inFlight) return inFlight
      if (closed || !deps.enabled()) return Promise.resolve()
      inFlight = (async () => {
        await installUv()
        await installPython(agentDir)
      })()
        .catch((error) => {
          logger.warn('uv pre-warm failed', { error: String(error) })
          if (state.python === 'installing') set({ python: 'failed' })
        })
        .finally(() => { inFlight = null })
      return inFlight
    },

    state(): UvPrewarmState {
      return { ...state, ...(state.failure ? { failure: { ...state.failure } } : {}) }
    },

    /**
     * The user-facing reason a finished `uv …` command failed because uv could
     * not start, or null for any other outcome (which keeps its usual text).
     * Redacted. A match also starts a new pre-warm, since the message promises
     * that running it again will work — unless one is installing, the platform
     * has no uv build, or the last install failed under {@link RETRY_BACKOFF_MS} ago.
     */
    async unavailableReason(command: string, outcome: { exitCode: number | null; stderr?: string | null }): Promise<string | null> {
      const matched = await uvCouldNotStart(command, outcome, async () => (await deps.resolveUv(await deps.runEnv())) !== null)
      if (!matched) return null
      const reason = redactCredentialText(uvUnavailableMessage(state.failure))
      if (shouldRetry()) void api.prewarm()
      return reason
    },

    /**
     * The app is quitting: kill a running `uv python install` and start no
     * more. Synchronous to the last signal (Electron does not await
     * `will-quit`), like the other owned children in `shutdownHubCore`.
     */
    shutdown(): void {
      closed = true
      deps.killRuns()
    }
  }
  return api
}

/** `uv python install` children still running. */
const activeRuns = new Set<ReturnType<typeof spawn>>()

function runInstall(bin: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd?: string }): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: null, stderr: error instanceof Error ? error.message : String(error) })
      return
    }
    activeRuns.add(child)
    let stderr = ''
    let settled = false
    const finish = (value: { code: number | null; stderr: string }): void => {
      if (settled) return
      settled = true
      activeRuns.delete(child)
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ code: null, stderr: `${stderr}\ntimed out after ${PYTHON_INSTALL_TIMEOUT_MS}ms` })
    }, PYTHON_INSTALL_TIMEOUT_MS)
    timer.unref?.()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000) })
    child.once('error', (error) => finish({ code: null, stderr: `${stderr}${error.message}` }))
    child.once('close', (code) => finish({ code, stderr }))
  })
}

export const uvPrewarm = createUvPrewarm({
  enabled: () => process.env['CINNA_UV_PREWARM'] !== 'off',
  ensureUv: () => toolchain.ensureUv(),
  runEnv: async () => withManagedUvFallback(shellEnvForChild(await getShellEnv())),
  resolveUv: (env) => resolveOnEnvPath('uv', env),
  contractPythonVersion: () => {
    try {
      return readContractFile(TEMPLATE_PYTHON_VERSION_FILE).trim() || null
    } catch {
      return null
    }
  },
  hasPythonVersionFile: (agentDir) => existsSync(join(agentDir, '.python-version')),
  run: runInstall,
  killRuns: () => {
    for (const child of activeRuns) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    activeRuns.clear()
  }
})

/** {@link uvPrewarm}'s `prewarm`: fire and forget. */
export function prewarm(agentDir?: string): Promise<void> {
  return uvPrewarm.prewarm(agentDir)
}

export function prewarmState(): UvPrewarmState {
  return uvPrewarm.state()
}

/** {@link uvPrewarm}'s `unavailableReason`; see there. */
export function uvUnavailableReason(command: string, outcome: { exitCode: number | null; stderr?: string | null }): Promise<string | null> {
  return uvPrewarm.unavailableReason(command, outcome)
}
