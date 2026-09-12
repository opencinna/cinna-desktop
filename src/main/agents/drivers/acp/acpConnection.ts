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
import { client, ndJsonStream } from '@agentclientprotocol/sdk'
import type {
  AnyMessage,
  ClientConnection,
  CreateElicitationResponse,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  Stream
} from '@agentclientprotocol/sdk'
import { createLogger } from '../../../logger/logger'
import {
  ACP_START_TIMEOUT_MS,
  ACP_STDERR_TAIL_LINES,
  type AcpConnection,
  type AcpExit,
  type AcpLaunchSpec,
  type AcpSessionHandlers,
  type StartAcpConnection
} from './types'

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

/** One buffered piece of session traffic, ready to be replayed into handlers. */
type BufferedDelivery = (handlers: AcpSessionHandlers) => void

interface PreBind {
  deliveries: BufferedDelivery[]
  /** Requests parked waiting for a bind; `null` means the window closed. */
  waiters: ((handlers: AcpSessionHandlers | null) => void)[]
  dropped: number
  timer: NodeJS.Timeout
}

/** `null` after `ms`, and never a reason for the process to stay awake. */
function afterGrace(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
  })
}

function sessionIdOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const id = (params as { sessionId?: unknown }).sessionId
  return typeof id === 'string' ? id : undefined
}

function paramsRecord(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
}

/**
 * See every incoming notification first, and keep the ones this file owns.
 *
 * Two things need the transport rather than the SDK's routing. The extension
 * traffic a real adapter sends has no schema, so the SDK drops it silently —
 * `_auth/status_update` appears 25 times in the Claude recordings, alongside
 * `usage_update`, `session_info_update`, `_session/steering`, `_session/goal`.
 * And `session/update` is validated against a closed union before any handler
 * runs (see the header), so an unknown kind never reaches one.
 *
 * `onNotification` returns true for a notification it has taken; that one is
 * not forwarded, so the SDK cannot route or reject it twice. Everything else
 * passes through untouched — responses and requests always do.
 */
function interceptNotifications(
  stream: Stream,
  onNotification: (method: string, params: unknown) => boolean
): Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        if ('method' in message && !('id' in message)) {
          let taken = false
          try {
            taken = onNotification(message.method, message.params)
          } catch (err) {
            logger.warn('notification handler threw', { method: message.method, error: String(err) })
          }
          if (taken) return
        }
        controller.enqueue(message)
      }
    })
  )
  return { writable: stream.writable, readable }
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

  // ---- session routing -----------------------------------------------------

  const bound = new Map<string, AcpSessionHandlers>()
  const preBind = new Map<string, PreBind>()

  const closeWindow = (sessionId: string): void => {
    const held = preBind.get(sessionId)
    if (!held) return
    preBind.delete(sessionId)
    clearTimeout(held.timer)
    if (held.deliveries.length > 0 || held.dropped > 0) {
      logger.warn('dropped traffic for a session nobody bound', {
        sessionId,
        buffered: held.deliveries.length,
        dropped: held.dropped
      })
    }
    for (const waiter of held.waiters) waiter(null)
  }

  const holdingPen = (sessionId: string): PreBind => {
    const existing = preBind.get(sessionId)
    if (existing) return existing
    const held: PreBind = {
      deliveries: [],
      waiters: [],
      dropped: 0,
      timer: setTimeout(() => closeWindow(sessionId), preBindWindowMs)
    }
    // The window must never be the reason the app stays awake.
    held.timer.unref?.()
    preBind.set(sessionId, held)
    return held
  }

  const deliver = (sessionId: string, delivery: BufferedDelivery): void => {
    const handlers = bound.get(sessionId)
    if (handlers) {
      try {
        delivery(handlers)
      } catch (err) {
        logger.warn('session handler threw', { sessionId, error: String(err) })
      }
      return
    }
    const held = holdingPen(sessionId)
    if (held.deliveries.length >= preBindLimit) {
      held.dropped += 1
      return
    }
    held.deliveries.push(delivery)
  }

  /**
   * The handlers for a session, waiting up to the pre-bind window for a bind.
   *
   * `null` means nobody claimed the session in time — the caller answers the
   * agent's blocking request with a cancellation rather than leaving it hanging
   * on a turn that never existed.
   */
  const handlersFor = (sessionId: string): Promise<AcpSessionHandlers | null> => {
    const now = bound.get(sessionId)
    if (now) return Promise.resolve(now)
    return new Promise((resolve) => holdingPen(sessionId).waiters.push(resolve))
  }

  const bindSession = (sessionId: string, handlers: AcpSessionHandlers): (() => void) => {
    bound.set(sessionId, handlers)
    const held = preBind.get(sessionId)
    if (held) {
      preBind.delete(sessionId)
      clearTimeout(held.timer)
      if (held.dropped > 0) {
        logger.warn('pre-bind buffer overflowed before the bind', {
          sessionId,
          kept: held.deliveries.length,
          dropped: held.dropped
        })
      }
      // In order, and before the parked requests resume: the waiters below can
      // only continue on a microtask, so a permission ask never overtakes the
      // updates that led to it.
      for (const delivery of held.deliveries) {
        try {
          delivery(handlers)
        } catch (err) {
          logger.warn('session handler threw on buffered traffic', { sessionId, error: String(err) })
        }
      }
      for (const waiter of held.waiters) waiter(handlers)
    }
    return () => {
      if (bound.get(sessionId) === handlers) bound.delete(sessionId)
    }
  }

  // ---- the client ----------------------------------------------------------

  // No `session/update` handler here on purpose — it is routed from the
  // transport tap below, where the SDK's schema cannot drop a kind it has not
  // heard of. Requests keep the typed handlers: an agent blocked on one needs a
  // valid answer, and validating what we answer is worth having.
  const app = client({ name: 'cinna-desktop' })
    .onRequest('session/request_permission', async (ctx) => {
      const handlers = await handlersFor(ctx.params.sessionId)
      if (!handlers) {
        logger.warn('permission asked for a session nobody bound', {
          sessionId: ctx.params.sessionId
        })
        return { outcome: { outcome: 'cancelled' } } satisfies RequestPermissionResponse
      }
      return handlers.onPermission(ctx.params)
    })
    .onRequest('elicitation/create', async (ctx) => {
      const sessionId = sessionIdOf(ctx.params)
      const handlers = sessionId ? await handlersFor(sessionId) : null
      if (!handlers?.onElicitation) {
        logger.warn('elicitation asked for a session nobody bound', { sessionId })
        return { action: 'cancel' } satisfies CreateElicitationResponse
      }
      return handlers.onElicitation(ctx.params)
    })

  const stdin = child.stdin
  const stdout = child.stdout
  if (!stdin || !stdout) {
    killTree(child, 'SIGKILL')
    throw new Error(`${spec.command} was started without stdio pipes`)
  }

  const transport = interceptNotifications(
    ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>
    ),
    (method, params) => {
      if (method === 'session/update') {
        const owner = sessionIdOf(params)
        const update = paramsRecord(params).update
        if (!owner || typeof update !== 'object' || update === null) {
          // Not addressed to a session, or carrying no update: there is nothing
          // to route it by. Taken all the same — handing the SDK a frame it can
          // only throw on gains nothing.
          logger.warn('session/update with no session id or no update')
          return true
        }
        // Whatever kind it is. The translator decides what it can fold; this
        // layer only decides whose turn it belongs to.
        const notification = params as SessionNotification
        deliver(owner, (handlers) => handlers.onUpdate(notification))
        return true
      }
      // `$/cancel_request` is the JSON-RPC layer's own. Everything else is an
      // extension, and the ones that name a session belong to that turn.
      if (method.startsWith('$/')) return false
      const sessionId = sessionIdOf(params)
      if (!sessionId) {
        // `_auth/status_update` is the one we know arrives this way — twice per
        // start, before `session/new` has even answered
        // (`claude/recordings/s1-session-new-mcp.ndjson`). It names no session,
        // so no turn can own it, and it carries the account email, so it is not
        // something to log the body of.
        logger.debug('extension notification with no session', { method })
        return false
      }
      const record = paramsRecord(params)
      deliver(sessionId, (handlers) => handlers.onExtNotification?.(method, record))
      return false
    }
  )

  let connection: ClientConnection
  try {
    connection = app.connect(transport)
  } catch (err) {
    killTree(child, 'SIGKILL')
    throw new Error(
      `could not speak ACP to ${spec.command}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

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
        for (const sessionId of [...preBind.keys()]) closeWindow(sessionId)
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
    const tail = stderrTail()
    await dispose()
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
    bindSession,
    stderrTail,
    dispose
  }
}

/** Compile-time proof that the seam the pool and the driver hold is still met. */
const _fitsSeam: StartAcpConnection = startAcpConnection
void _fitsSeam
