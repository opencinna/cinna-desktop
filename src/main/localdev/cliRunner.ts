/**
 * Running cinna-cli and reading its machine-readable output.
 *
 * cinna-cli owns everything about an account workspace — the token exchange,
 * the layout, the context package, sync. The desktop's whole job is to spawn it
 * correctly and understand what came back, which is what this file is. There is
 * deliberately no code here that knows what a workspace *contains*.
 *
 * ## The protocol
 *
 * With `--json`, cinna-cli writes one JSON object per line to stdout and
 * nothing else:
 *
 * ```
 * {"step":1,"total":3,"status":"start","message":"Authenticating..."}
 * {"step":1,"total":3,"status":"ok","message":"…"}
 * {"result":"ok", …}                     ← or {"result":"error","code":"…","detail":"…"}
 * ```
 *
 * `--json` implies `--no-input`, so a prompt can never appear and stall a spawn
 * that has no terminal attached.
 *
 * ## Exit codes are the contract, not the text
 *
 * `0` ok · `10` the setup token was rejected (invalid, expired, already used) ·
 * `11` the token belongs to a different account than the workspace · `12` the
 * platform could not be reached · `2` the desktop called cinna-cli wrongly ·
 * `1` everything else. The reconciler maps these onto what the user is shown,
 * so a message-string match is never load-bearing here — messages are written
 * for people and will change.
 *
 * ## The setup command is a secret
 *
 * `setup_command` embeds a single-use token that is live for fifteen minutes.
 * It is passed as an **argv element** and is never logged, never interpolated
 * into a shell string, and never included in an error detail. `spawn` without a
 * shell is what makes the argv promise real: no quoting, no `$(…)`, nothing for
 * a token containing a shell metacharacter to escape into.
 */

import { spawn } from 'node:child_process'
import { createLogger } from '../logger/logger'

const logger = createLogger('cinna-cli')

/** Ceiling on one cinna-cli run. Setup downloads a context package; be generous. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000

/**
 * A stray line that is not JSON is dropped rather than failing the run, but a
 * flood of them means something is writing to stdout that should not be — cap
 * what is kept for the log.
 */
const MAX_NOISE_LINES = 20

export interface CliProgressLine {
  step?: number
  total?: number
  status: 'start' | 'ok' | 'warn' | 'fail'
  message: string
}

/** The final line: `{"result":"ok",…}` or `{"result":"error","code":…}`. */
export interface CliResultLine {
  result: 'ok' | 'error'
  code?: string
  detail?: string
  [key: string]: unknown
}

export interface CliRunOutcome {
  /** The process exit code, or null when it was killed. */
  exitCode: number | null
  /** The `{"result":…}` line, when one was written. */
  result: CliResultLine | null
  /** stderr, trimmed and capped — for a log line, never for a decision. */
  stderr: string
  /**
   * Raw stdout, only when {@link CliRunOptions.captureStdout} asked for it.
   *
   * Off by default because in JSON mode stdout is the protocol and keeping a
   * second copy of it invites a caller to parse the text instead of the lines.
   * The capability probe is the one caller that wants text: `--help` is prose,
   * and its shape is what it is asking about.
   */
  stdout: string
  /** True when the run was cut short by {@link CliRunOptions.timeoutMs}. */
  timedOut: boolean
}

export interface CliRunOptions {
  /** Absolute path to the managed `cinna`. */
  bin: string
  /** Argv after the binary. Secrets go here, never into `env` or a shell. */
  args: string[]
  /** From `toolchain.toolchainEnv()` — the only env a cinna-cli spawn gets. */
  env: NodeJS.ProcessEnv
  /** Working directory. `cinna account status` finds the workspace by walking up. */
  cwd?: string
  onProgress?: (line: CliProgressLine) => void
  timeoutMs?: number
  /** Keep raw stdout in the outcome. Only the `--help` capability probe does. */
  captureStdout?: boolean
  /**
   * Argv rendered for the log, with any secret already replaced. Required so
   * that logging a command is a deliberate act rather than a default that one
   * day logs a token.
   */
  logArgs: string[]
}

function isProgressLine(value: Record<string, unknown>): boolean {
  return typeof value.status === 'string' && typeof value.message === 'string'
}

/**
 * Spawn cinna-cli and resolve what happened. **Never rejects** on a non-zero
 * exit: a failing cinna-cli run is an outcome the reconciler renders, and a
 * rejection would drop the exit code that says which outcome it is.
 */
export function runCinnaCli(opts: CliRunOptions): Promise<CliRunOutcome> {
  return new Promise((resolve) => {
    logger.info('running cinna-cli', { args: opts.logArgs })

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        // No shell: the argv array is the promise that a token cannot be
        // re-parsed by anything. `ignore` on stdin so a cinna-cli that somehow
        // asked for input fails fast instead of hanging on a pipe nobody writes.
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({
        exitCode: null,
        result: { result: 'error', code: 'spawn_failed', detail: String(err) },
        stderr: String(err),
        stdout: '',
        timedOut: false
      })
      return
    }

    let stdoutBuffer = ''
    let stdoutRaw = ''
    let stderr = ''
    let result: CliResultLine | null = null
    let noise = 0
    let timedOut = false
    let settled = false

    const consumeLine = (raw: string): void => {
      const line = raw.trim()
      if (!line) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // cinna-cli promises stdout is JSON-only in `--json` mode. Anything
        // else is a bug on its side or a library printing over it; note it and
        // carry on rather than failing a setup that may well have worked.
        if (noise++ < MAX_NOISE_LINES) logger.warn('non-JSON line on cinna-cli stdout')
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const obj = parsed as Record<string, unknown>
      if (typeof obj.result === 'string') {
        result = obj as CliResultLine
        return
      }
      if (isProgressLine(obj)) {
        opts.onProgress?.(obj as unknown as CliProgressLine)
      }
    }

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Whatever is left in the buffer without a trailing newline is still a
      // line — the final `{"result":…}` arrives this way when the process
      // exits promptly after writing it.
      consumeLine(stdoutBuffer)
      stdoutBuffer = ''
      resolve({
        exitCode,
        result,
        stderr: stderr.trim().slice(0, 2000),
        stdout: stdoutRaw,
        timedOut
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      logger.warn('cinna-cli timed out', { args: opts.logArgs })
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(null)
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (opts.captureStdout && stdoutRaw.length < 64 * 1024) stdoutRaw += chunk
      stdoutBuffer += chunk
      let newline = stdoutBuffer.indexOf('\n')
      while (newline !== -1) {
        consumeLine(stdoutBuffer.slice(0, newline))
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        newline = stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk
    })

    child.on('error', (err) => {
      stderr += String(err)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
