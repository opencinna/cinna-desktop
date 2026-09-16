/**
 * One agent process, and the ACP conversation carried over its stdio.
 *
 * ## Why the environment is the spec's and nothing else
 *
 * `spawn` inherits `process.env` when `env` is omitted, and this process is an
 * Electron main process holding decrypted provider keys, the user's shell
 * environment and whatever the packaged app was launched with. A coding agent
 * is a program that runs arbitrary commands on the user's machine; what it can
 * see of our environment is a decision, not a default. The launcher builds the
 * whole environment and `spec.env` is passed verbatim — no merge, no spread of
 * `process.env` anywhere in this file.
 *
 * ## Why the child leads its own process group
 *
 * An ACP agent is rarely one process. `claude-agent-acp` spawns the `claude`
 * CLI, which spawns the tools the model asks for; `opencode acp` forks its own
 * workers. Signalling the child alone leaves those grandchildren running with
 * the stdio pipes still open, which is how `commandService.killTree` was
 * written (see its header — the lesson was learned by running it, not by
 * reasoning about it). `detached` on POSIX makes the child a group leader so
 * `process.kill(-pid)` reaches the whole tree; Windows has no equivalent and
 * takes `taskkill /T`.
 *
 * ## Why traffic is buffered before anyone binds
 *
 * Messages are *read* in order and *processed* concurrently: the SDK's
 * connection dispatches each incoming message without awaiting the previous one
 * (`jsonrpc.js` `receive` → `receiveMessage`), so a `session/new` response and
 * the `session/update` notifications written right behind it race each other
 * through the client. That is not a hypothetical: in
 * `spike/acp/claude/recordings/s1-session-new-mcp.ndjson` the
 * `available_commands_update` for a session follows its `session/new` response
 * with nothing in between, and in `opencode/recordings/q2-permission.ndjson`
 * the same happens after `session/set_config_option`. A turn that binds its
 * handlers on the `session/new` answer would therefore drop the opening of its
 * own turn some fraction of the time. So an unbound session id gets a short,
 * bounded holding pen instead, and a bind drains it in order. See
 * {@link AcpConnection.bindSession} in `types.ts` for the contract.
 *
 * ## Why `fs/*` and `terminal/*` answer "method not found"
 *
 * We declare neither client capability, which per ACP means an agent must not
 * call them — and v2 removes them outright. OpenCode 1.18.27 calls
 * `fs/write_text_file` regardless (three times in
 * `opencode/recordings/q2-permission.ndjson`); on the `-32601` it writes the
 * file itself and the turn continues to `tool_call_update: completed`. So the
 * error is the *working* answer, and it costs nothing: the SDK's connection
 * replies `-32601` to any request no handler claims, which is exactly what the
 * spike client did to produce that recording. Answering them for real would
 * hand the agent a second, unaudited write path; crashing would break turns
 * that work today.
 *
 * ## Why `session/update` is taken off the wire before the SDK sees it
 *
 * The SDK validates it, and validation here means loss. `zSessionUpdate`
 * (`schema/zod.gen.js`) is a closed union of the `sessionUpdate` literals this
 * SDK version knows, and `ClientApp`'s constructor installs a session-update
 * router as a *static* handler that parses every one of them before any
 * handler we register — so a kind the schema has not heard of throws there,
 * ahead of anything permissive we could register, and the update is dropped
 * with a `console.error`. Measured, not assumed: the connection survives it
 * (the SDK catches a throwing notification handler), so the cost is one lost
 * update per unknown kind rather than a dead turn — which is worse, being
 * invisible.
 *
 * Nothing in the recordings is outside the 1.4.0 schema today. One `opencode`
 * or `claude-agent-acp` bump is all it takes, and what would go missing is a
 * chunk of a message. So this file consumes `session/update` in the transport
 * tap, checks only what routing needs (a session id, an object update) and
 * hands the notification over as it arrived. `acpMessages` already ignores
 * kinds it does not know, which is the behaviour that belongs at that layer,
 * not here.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type {
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse
} from '@agentclientprotocol/sdk'
import { createLogger } from '../../../logger/logger'
import {
  ACP_START_TIMEOUT_MS,
  ACP_STDERR_TAIL_LINES,
  ACP_STEER_METHOD,
  type AcpSteerRequest,
  type AcpSteerResponse,
  type AcpConnection,
  type AcpExit,
  type AcpLaunchSpec,
  type StartAcpConnection
} from './types'

import { connectAcpClient } from './acpClient'
import { startAcpWebSocketConnection } from './acpWebSocketConnection'

const logger = createLogger('acp-connection')

/**
 * How many notifications one unbound session id may pile up, and for how long.
 *
 * The numbers are the ones `types.ts` documents on `bindSession`; they live
 * here because nothing outside this file can act on them. The window covers the
 * gap between a response and the turn's bind — milliseconds — so anything near
 * either bound means a session nobody is listening to, and the warning below is
 * the interesting part, not the retention.
 */
const PRE_BIND_LIMIT = 500
const PRE_BIND_WINDOW_MS = 10_000

/** How long a killed process gets to die on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000

/**
 * How long a failure waits for the process to explain itself by exiting.
 *
 * When an agent dies mid-request the *stream* closing is what the SDK notices
 * first: the pending `initialize` rejects with "ACP connection closed" a beat
 * before Node delivers the child's `exit` event. Reporting that first answer
 * would tell the user their agent's connection closed, when what happened is
 * that it exited with code 3 after printing why. The exit is only ever
 * milliseconds behind, and this grace is paid on the failure path alone.
 */
const EXIT_REPORT_GRACE_MS = 250

/**
 * Seams the tests need and production never sets.
 *
 * Every value has a production default taken from `types.ts` or from the
 * constants above. They are here so a test can prove the *behaviour* at a
 * window of 60 ms instead of waiting ten seconds for the real one, which is the
 * only way these paths get covered at all.
 */
export interface AcpConnectionOptions {
  /** Cancel a standalone initialize probe, disposing its process before rejection. */
  signal?: AbortSignal
  /** Overrides {@link ACP_START_TIMEOUT_MS}. */
  startTimeoutMs?: number
  /** Overrides {@link PRE_BIND_WINDOW_MS}. */
  preBindWindowMs?: number
  /** Overrides {@link PRE_BIND_LIMIT}. */
  preBindLimit?: number
  /** Overrides {@link KILL_GRACE_MS}. */
  killGraceMs?: number
}

/** `null` after `ms`, without keeping the process awake. */
function afterGrace(ms: number): Promise<null> {
  return new Promise((resolve) => { const timer = setTimeout(() => resolve(null), ms); timer.unref?.() })
}

/**
 * Kill `child` and every process it forked.
 *
 * Modelled on `commandService.killTree`: the negative pid signals the whole
 * group the `detached` spawn made this child the leader of, and Windows — which
 * has no such group — gets `taskkill /T`. Failures are success in disguise
 * here; the only reason the group would refuse a signal is that it is already
 * gone.
 */
function killTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!child.pid) {
    try {
      child.kill(signal)
    } catch {
      // No pid was ever assigned — there is nothing to signal.
    }
    return
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
      // Best effort: an already-dead process is the outcome we wanted.
    })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already reaped.
    }
  }
}

/**
 * Spawn one agent and complete `initialize`.
 *
 * Rejects — after killing whatever was spawned — when the process cannot start,
 * dies before answering, or takes longer than {@link ACP_START_TIMEOUT_MS}. The
 * message carries the stderr tail because the two failures that actually happen
 * are a command that is not there and an adapter that refuses to boot, and both
 * of them explain themselves on stderr and nowhere else.
 */
export async function startAcpConnection(
  spec: AcpLaunchSpec,
  init: InitializeRequest,
  options: AcpConnectionOptions = {}
): Promise<AcpConnection> {
  if (spec.remote) return startAcpWebSocketConnection(spec.remote, init, options)
  if (options.signal?.aborted) throw new Error('The command test was canceled.')
  const startTimeoutMs = options.startTimeoutMs ?? ACP_START_TIMEOUT_MS
  const preBindWindowMs = options.preBindWindowMs ?? PRE_BIND_WINDOW_MS
  const preBindLimit = options.preBindLimit ?? PRE_BIND_LIMIT
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS

  let child: ChildProcess
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // New process group on POSIX so the whole tree can be signalled at once;
      // meaningless (and harmless) on Windows, where `killTree` uses taskkill.
      detached: process.platform !== 'win32'
    })
  } catch (err) {
    throw new Error(`could not start ${spec.command}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- stderr tail ---------------------------------------------------------

  const stderrLines: string[] = []
  let stderrPartial = ''
  const pushStderr = (chunk: string): void => {
    const parts = (stderrPartial + chunk).split('\n')
    stderrPartial = parts.pop() ?? ''
    for (const line of parts) {
      stderrLines.push(line)
      if (stderrLines.length > ACP_STDERR_TAIL_LINES) stderrLines.shift()
    }
  }
  const stderrTail = (): string => {
    const lines = stderrPartial ? [...stderrLines, stderrPartial] : stderrLines
    return lines.slice(-ACP_STDERR_TAIL_LINES).join('\n')
  }
  const stderrClosed = new Promise<void>((resolve) => {
    if (!child.stderr) resolve()
    else child.stderr.once('close', resolve)
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => pushStderr(chunk))
  child.stderr?.on('error', () => {
    // A closed pipe on a dying process is not news.
  })
  // A write to a dead agent's stdin raises EPIPE on the stream itself; without
  // a listener Node turns that into an uncaught exception and takes the app
  // down. The failure is already reported through `exited`.
  child.stdin?.on('error', (err) => logger.debug('stdin closed', { error: String(err) }))

  // ---- exit ----------------------------------------------------------------

  let alive = true
  let settled = false
  let resolveExit!: (exit: AcpExit) => void
  const exited = new Promise<AcpExit>((resolve) => {
    resolveExit = resolve
  })
  const settleExit = (code: number | null, signal: string | null): void => {
    if (settled) return
    settled = true
    alive = false
    resolveExit({ code, signal, stderrTail: stderrTail() })
  }
  let spawnError: string | null = null
  child.on('exit', (code, signal) => settleExit(code, signal))
  child.on('error', (err) => {
    // ENOENT and friends: no exit event is coming, so this *is* the exit.
    spawnError = err instanceof Error ? err.message : String(err)
    pushStderr(`${spawnError}\n`)
    settleExit(null, null)
  })

  const stdin = child.stdin
  const stdout = child.stdout
  if (!stdin || !stdout) {
    killTree(child, 'SIGKILL')
    throw new Error(`${spec.command} was started without stdio pipes`)
  }
  const { connection, bindSession, observeSession, clearRouting } = connectAcpClient(ndJsonStream(
    Writable.toWeb(stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout) as ReadableStream<Uint8Array>
  ), preBindWindowMs, preBindLimit)

  // ---- dispose -------------------------------------------------------------

  let disposal: Promise<void> | null = null

  // The stream is the only way to reach the process. If it closes while the
  // process is alive *and nobody asked for that*, the process is unreachable
  // rather than healthy — kill it, so `exited` settles and the pool stops
  // handing out a connection whose pipe is gone. During our own dispose the
  // stream closing is the expected first symptom of the kill, not news.
  void connection.closed.then(async () => {
    alive = false
    // A closing stream is also the first symptom of a process that is already
    // on its way out, and Node delivers `exit` a beat later — so give the exit
    // its moment before calling this an unreachable process.
    await Promise.race([exited, afterGrace(EXIT_REPORT_GRACE_MS)])
    if (!settled && !disposal) {
      logger.warn('ACP stream closed while the process was alive', { pid: child.pid })
      killTree(child, 'SIGKILL')
    }
  })

  const dispose = (): Promise<void> => {
    if (!disposal) {
      disposal = (async () => {
        if (!settled) {
          killTree(child, 'SIGTERM')
          const grace = setTimeout(() => killTree(child, 'SIGKILL'), killGraceMs)
          grace.unref?.()
          await exited
          clearTimeout(grace)
        }
        await exited
        clearRouting()
        try {
          connection.close()
        } catch {
          // Closing a connection whose transport already ended is a no-op we
          // do not need to hear about.
        }
      })()
    }
    return disposal
  }

  // ---- initialize ----------------------------------------------------------

  const failure = async (reason: string): Promise<never> => {
    await dispose()
    await Promise.race([stderrClosed, afterGrace(EXIT_REPORT_GRACE_MS)])
    const tail = stderrTail()
    throw new Error(
      `${spec.command} ${reason}${tail ? `\n--- stderr ---\n${tail}` : ''}`.trim()
    )
  }

  const died = (exit: AcpExit): string =>
    spawnError
      ? `could not be started (${spawnError})`
      : `exited (${exit.signal ?? `code ${exit.code}`}) before answering initialize`

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), startTimeoutMs)
    timer.unref?.()
  })

  let abortStart!: () => void
  const aborted = new Promise<'aborted'>((resolve) => { abortStart = () => resolve('aborted') })
  options.signal?.addEventListener('abort', abortStart, { once: true })
  if (options.signal?.aborted) abortStart()
  type StartOutcome = { response: InitializeResponse } | { exit: AcpExit } | 'timeout' | 'aborted'
  let outcome: StartOutcome
  try {
    outcome = await Promise.race<StartOutcome>([
      connection.agent.request('initialize', init).then((response) => ({ response })),
      exited.then((exit) => ({ exit })),
      timeout, aborted
    ])
  } catch (err) {
    // The request lost its transport. Nine times in ten that is the process
    // dying, and the exit says far more than "connection closed" does.
    const exit = await Promise.race([exited, afterGrace(EXIT_REPORT_GRACE_MS)])
    return await failure(
      exit ? died(exit) : `failed initialize: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortStart)
  }

  if (outcome === 'aborted') return await failure('initialization was canceled')
  if (outcome === 'timeout') {
    return await failure(`did not answer initialize within ${startTimeoutMs} ms`)
  }
  if ('exit' in outcome) {
    return await failure(died(outcome.exit))
  }
  const initialized: InitializeResponse = outcome.response

  logger.info('ACP process ready', {
    command: spec.command,
    pid: child.pid,
    protocolVersion: initialized.protocolVersion
  })

  const call = connection.agent
  return {
    get pid() {
      return child.pid
    },
    initialized,
    get alive() {
      return alive
    },
    exited,
    newSession: (params: NewSessionRequest): Promise<NewSessionResponse> =>
      call.request('session/new', params),
    loadSession: (params: LoadSessionRequest): Promise<LoadSessionResponse> =>
      call.request('session/load', params),
    setSessionMode: (params: SetSessionModeRequest): Promise<SetSessionModeResponse> =>
      call.request('session/set_mode', params),
    setSessionConfigOption: (
      params: SetSessionConfigOptionRequest
    ): Promise<SetSessionConfigOptionResponse> => call.request('session/set_config_option', params),
    prompt: (params: PromptRequest): Promise<PromptResponse> => call.request('session/prompt', params),
    cancel: (sessionId: string): Promise<void> => call.notify('session/cancel', { sessionId }),
    steer: (params: AcpSteerRequest): Promise<AcpSteerResponse> =>
      call.request<AcpSteerResponse, AcpSteerRequest>(ACP_STEER_METHOD, params),
    bindSession,
    observeSession,
    stderrTail,
    dispose
  }
}

/** Compile-time proof that the seam the pool and the driver hold is still met. */
const _fitsSeam: StartAcpConnection = startAcpConnection
void _fitsSeam
