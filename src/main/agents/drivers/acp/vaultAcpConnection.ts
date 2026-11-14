/**
 * The third ACP transport, beside stdio (`acpConnection.ts`) and WebSocket
 * (`acpWebSocketConnection.ts`): an engine running inside an Agent Vault.
 *
 * The vault's cinna-vaultd starts the engine (`engine.spawn`: it builds the
 * command itself, D29), and its stdio is a stream main attaches to with a
 * second vaultd connection. That stream is ndjson ACP, so everything above
 * the transport (routing, the pen, the driver) is unchanged.
 *
 * ## What counts as the process ending
 *
 * The attached stream closing (vaultd ends it when the engine's stdout ends)
 * or vaultd's `engine.exit` notification, whichever comes first; the exit
 * notification carries the stderr tail. A **stall is not an exit**: a vault
 * that locks mid-turn pauses its VM (D22), and the stream simply goes quiet
 * until the next unlock. The vault service closing its control connection on
 * a lock is not an exit either: the engine is bound to the attached stream,
 * not to the control connection.
 */
import type { InitializeRequest, InitializeResponse } from '@agentclientprotocol/sdk'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { createLogger } from '../../../logger/logger'
import type { VaultChannel } from '../../../vault/backend'
import type { VaultdClient } from '../../../vault/vaultdClient'
import { connectAcpClient } from './acpClient'
import {
  ACP_ASYNC_TASK_STOP_METHOD,
  ACP_CONTEXT_USAGE_METHOD,
  ACP_START_TIMEOUT_MS,
  ACP_STEER_METHOD,
  type AcpAsyncTaskStopRequest,
  type AcpAsyncTaskStopResponse,
  type AcpConnection,
  type AcpContextUsageRequest,
  type AcpExit,
  type AcpSteerRequest,
  type AcpSteerResponse,
  type AcpVaultLaunch
} from './types'

const logger = createLogger('acp-vault')

/** Where a start failure's message carries the engine's stderr tail. */
const STDERR_MARKER = '\n--- stderr ---\n'

/**
 * A start failure's message without the engine's stderr tail: what of a
 * vault engine's failure may be logged or shown on this computer. The tail
 * (whatever the engine printed inside the vault) stays in the full message,
 * which only the vault chat's error row keeps.
 */
export function withoutStderrTail(message: string): string {
  const at = message.indexOf(STDERR_MARKER)
  return at < 0 ? message : message.slice(0, at)
}

/** The part of a vaultd client an engine stream needs. */
export type VaultEngineClient = Pick<VaultdClient, 'request' | 'attach' | 'onNotification'>

export interface VaultAcpConnectionOptions {
  signal?: AbortSignal
  startTimeoutMs?: number
  preBindWindowMs?: number
  preBindLimit?: number
  /** How long to wait for `engine.exit` (and its stderr tail) after the stream ended. */
  exitGraceMs?: number
  /** The vault's vaultd control connection. Default: the vault service's shared one. */
  client?: (vaultId: string) => Promise<VaultEngineClient>
}

async function defaultClient(vaultId: string): Promise<VaultEngineClient> {
  const { vaultService } = await import('../../../vault/vaultService')
  return vaultService.client(vaultId)
}

/** Spawn the engine in the vault, attach, and complete `initialize`. Rejects with a readable message. */
export async function startVaultAcpConnection(
  vault: AcpVaultLaunch,
  init: InitializeRequest,
  options: VaultAcpConnectionOptions = {}
): Promise<AcpConnection> {
  if (options.signal?.aborted) throw new Error('The vault engine start was canceled.')
  const client = await (options.client ?? defaultClient)(vault.vaultId)

  // Listening before the spawn: an engine that dies at once must not lose its exit.
  let streamId: string | null = null
  const early = new Map<string, AcpExit>()
  let alive = true
  let settled = false
  let tail = ''
  let resolveExit!: (exit: AcpExit) => void
  const exited = new Promise<AcpExit>((resolve) => { resolveExit = resolve })
  const settle = (exit: AcpExit): void => {
    if (settled) return
    settled = true
    alive = false
    tail = exit.stderrTail
    resolveExit(exit)
  }
  const stopListening = client.onNotification((notification) => {
    if (notification.method !== 'engine.exit') return
    const { stream, code, signal, stderrTail } = notification.params
    const exit: AcpExit = { code, signal, stderrTail: stderrTail ?? '' }
    if (streamId === null) early.set(stream, exit)
    else if (stream === streamId) settle(exit)
  })

  let spawned: { stream: string; pid: number }
  try {
    spawned = await client.request('engine.spawn', { engine: vault.engine, options: { extraEnv: { ...vault.extraEnv }, ...(vault.mode ? { mode: vault.mode } : {}) } })
  } catch (error) {
    stopListening()
    throw new Error(`The ${vault.engine} engine could not be started in the vault: ${error instanceof Error ? error.message : String(error)}`)
  }
  streamId = spawned.stream
  const already = early.get(streamId)
  early.clear()
  if (already) settle(already)

  let channel: VaultChannel
  try {
    channel = await client.attach(streamId)
  } catch (error) {
    stopListening()
    await client.request('engine.kill', { stream: streamId }).catch(() => {})
    throw new Error(`The vault engine could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }

  const exitGraceMs = options.exitGraceMs ?? 1_000
  const { connection, bindSession, observeSession, aliasSession, onConnectionExt, clearRouting } = connectAcpClient(
    ndJsonStream(channel.writable, channel.readable),
    options.preBindWindowMs,
    options.preBindLimit
  )

  // The stream ending is the engine ending (vaultd ends it with the engine's
  // stdout). `engine.exit` usually lands first; if not, give it a moment for
  // its stderr tail, then settle without one.
  void connection.closed.then(async () => {
    alive = false
    if (settled) return
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, exitGraceMs).unref?.())])
    settle({ code: null, signal: null, stderrTail: '' })
  })

  let disposal: Promise<void> | null = null
  const dispose = (): Promise<void> => {
    if (!disposal) {
      disposal = (async () => {
        stopListening()
        if (!settled) {
          // Best effort: a control connection a lock closed cannot ask; closing
          // the attached stream kills the engine in the guest anyway.
          await client.request('engine.kill', { stream: streamId! }, 5_000).catch(() => {})
        }
        channel.close('disposed')
        clearRouting()
        try {
          connection.close()
        } catch {
          // already ended
        }
        settle({ code: null, signal: 'SIGTERM', stderrTail: tail })
      })()
    }
    return disposal
  }

  // ---- initialize ----------------------------------------------------------

  const startTimeoutMs = options.startTimeoutMs ?? ACP_START_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), startTimeoutMs)
    timer.unref?.()
  })
  let abortStart!: () => void
  const aborted = new Promise<'aborted'>((resolve) => { abortStart = () => resolve('aborted') })
  options.signal?.addEventListener('abort', abortStart, { once: true })
  if (options.signal?.aborted) abortStart()

  const failure = async (reason: string): Promise<never> => {
    const lastTail = tail
    await dispose()
    throw new Error(`The vault's ${vault.engine} engine ${reason}${lastTail ? `${STDERR_MARKER}${lastTail}` : ''}`.trim())
  }

  // The start (initialize, then any sign-in) runs under one deadline, and
  // gives up at once when the engine exits or the start is canceled.
  const stopWatchingStart = (): void => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortStart)
  }

  type Outcome = { response: InitializeResponse } | { exit: AcpExit } | 'timeout' | 'aborted'
  let outcome: Outcome
  try {
    outcome = await Promise.race<Outcome>([
      connection.agent.request('initialize', init).then((response) => ({ response })),
      exited.then((exit) => ({ exit })),
      timeout,
      aborted
    ])
  } catch (error) {
    const exit = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), exitGraceMs).unref?.())])
    stopWatchingStart()
    return await failure(exit ? `exited (${exit.signal ?? `code ${exit.code}`}) before answering initialize` : `failed initialize: ${error instanceof Error ? error.message : String(error)}`)
  }
  const ended = async (step: string, outcome: 'timeout' | 'aborted' | { exit: AcpExit }): Promise<never> => {
    stopWatchingStart()
    if (outcome === 'aborted') return await failure('start was canceled')
    if (outcome === 'timeout') return await failure(`did not answer ${step} within ${startTimeoutMs} ms`)
    return await failure(`exited (${outcome.exit.signal ?? `code ${outcome.exit.code}`}) before answering ${step}`)
  }
  if (outcome === 'aborted' || outcome === 'timeout' || 'exit' in outcome) return await ended('initialize', outcome)
  const initialized = outcome.response

  const call = connection.agent
  if (vault.authMethod) {
    // The engine's own login, with the key vaultd put in its environment. A
    // refusal fails the start in words; the key itself never crosses here.
    type SignIn = { signedIn: true } | { exit: AcpExit } | 'timeout' | 'aborted'
    let signIn: SignIn
    try {
      signIn = await Promise.race<SignIn>([
        call.request('authenticate', { methodId: vault.authMethod }).then(() => ({ signedIn: true as const })),
        exited.then((exit) => ({ exit })),
        timeout,
        aborted
      ])
    } catch (error) {
      stopWatchingStart()
      const message = (error as { data?: { message?: unknown } } | null)?.data?.message
      return await failure(`could not sign in (${vault.authMethod}): ${typeof message === 'string' ? message : error instanceof Error ? error.message : String(error)}`)
    }
    if (signIn === 'aborted' || signIn === 'timeout' || 'exit' in signIn) return await ended('authenticate', signIn)
  }
  stopWatchingStart()
  logger.info('vault ACP engine ready', { vaultId: vault.vaultId, engine: vault.engine, protocolVersion: initialized.protocolVersion })
  return {
    pid: undefined,
    initialized,
    get alive() { return alive },
    exited,
    newSession: (params) => call.request('session/new', params),
    loadSession: (params) => call.request('session/load', params),
    setSessionMode: (params) => call.request('session/set_mode', params),
    setSessionConfigOption: (params) => call.request('session/set_config_option', params),
    prompt: (params) => call.request('session/prompt', params),
    cancel: (sessionId) => call.notify('session/cancel', { sessionId }),
    steer: (params) => call.request<AcpSteerResponse, AcpSteerRequest>(ACP_STEER_METHOD, params),
    stopAsyncTask: (params) => call.request<AcpAsyncTaskStopResponse, AcpAsyncTaskStopRequest>(ACP_ASYNC_TASK_STOP_METHOD, params),
    contextUsage: (params) => call.request<unknown, AcpContextUsageRequest>(ACP_CONTEXT_USAGE_METHOD, params),
    bindSession,
    observeSession,
    aliasSession,
    onConnectionExt,
    stderrTail: () => tail,
    dispose
  }
}
