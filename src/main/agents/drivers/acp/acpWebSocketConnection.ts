import { WebSocket } from 'undici'
import type { AnyMessage, InitializeRequest, InitializeResponse, Stream } from '@agentclientprotocol/sdk'
import { connectAcpClient } from './acpClient'
import { ACP_START_TIMEOUT_MS, ACP_STEER_METHOD, type AcpConnection, type AcpExit, type AcpSteerRequest, type AcpSteerResponse } from './types'
import { parseRemoteAcpConfig, parseAcpAccessToken, type RemoteAcpConfig } from '../../../../shared/customAgents'

/** Cinna-core/Python SDK profile: one UTF-8 JSON-RPC object per text frame. */
export async function startAcpWebSocketConnection(
  remote: RemoteAcpConfig & { accessToken?: string },
  init: InitializeRequest,
  options: { signal?: AbortSignal; startTimeoutMs?: number; preBindWindowMs?: number; preBindLimit?: number } = {}
): Promise<AcpConnection> {
  const config = parseRemoteAcpConfig(remote)
  const token = parseAcpAccessToken(remote.accessToken)
  if (options.signal?.aborted) throw new Error('The ACP connection was canceled.')
  const socket = new WebSocket(config.url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  let alive = true
  let controller!: ReadableStreamDefaultController<AnyMessage>
  let resolveExit!: (exit: AcpExit) => void
  const exited = new Promise<AcpExit>((resolve) => { resolveExit = resolve })
  let failure: Error | undefined
  const close = (error?: Error): void => {
    if (!alive) return
    alive = false
    failure = error
    if (error) controller.error(error); else controller.close()
    socket.close()
    resolveExit({ code: null, signal: null, stderrTail: error?.message ?? '' })
  }
  const readable = new ReadableStream<AnyMessage>({
    start(value) { controller = value },
    cancel() { close() }
  }, { highWaterMark: 8 * 1024 * 1024, size: (message) => Buffer.byteLength(JSON.stringify(message)) })
  socket.addEventListener('message', (event) => {
    if (!alive) return
    try {
      if (typeof event.data !== 'string') throw new Error('ACP requires JSON-RPC text frames.')
      const size = Buffer.byteLength(event.data)
      if (size > 1024 * 1024 || size > (controller.desiredSize ?? 0)) throw new Error('The ACP server exceeded the incoming message limit.')
      const message = JSON.parse(event.data)
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' ||
        (typeof message.method !== 'string' && !('id' in message && ('result' in message || 'error' in message)))) {
        throw new Error('The ACP server sent an invalid JSON-RPC frame.')
      }
      controller.enqueue(message)
    } catch { close(new Error('The ACP server sent an invalid or oversized JSON-RPC text frame.')) }
  })
  socket.addEventListener('error', () => close(new Error('Could not connect to the ACP server. Check the endpoint, access token, and network.')))
  socket.addEventListener('close', () => close(new Error('The ACP server closed the connection.')))
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const frame = JSON.stringify(message)
      if (!alive || socket.readyState !== WebSocket.OPEN) throw failure ?? new Error('The ACP connection is closed.')
      if (Buffer.byteLength(frame) > 256 * 1024) throw new Error('The ACP request exceeds the 256 KiB frame limit.')
      socket.send(frame)
      const deadline = Date.now() + 15_000
      while (socket.bufferedAmount > 0) {
        if (!alive) throw failure ?? new Error('The ACP connection is closed.')
        if (Date.now() >= deadline) { close(new Error('The ACP server stopped accepting messages.')); throw failure }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    close() { close() },
    abort() { close() }
  })
  const stream: Stream = { readable, writable }
  // Bind the reader before open so opening notifications cannot be lost.
  const { connection, bindSession, clearRouting } = connectAcpClient(stream, options.preBindWindowMs, options.preBindLimit)
  const dispose = async (): Promise<void> => { close(); clearRouting(); connection.close() }
  void connection.closed.then(() => { close(); clearRouting() })
  const abort = (): void => close(new Error('The ACP connection was canceled.'))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(() => close(new Error('The ACP server did not answer initialization in time.')), options.startTimeoutMs ?? ACP_START_TIMEOUT_MS)
  timer.unref?.()
  try {
    const opened = new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.OPEN) resolve()
      else socket.addEventListener('open', () => resolve(), { once: true })
    })
    const ended = exited.then(() => { throw failure ?? new Error('The ACP connection is closed.') })
    await Promise.race([opened, ended])
    const initialized: InitializeResponse = await Promise.race([connection.agent.request('initialize', init), ended])
    if (initialized.protocolVersion !== init.protocolVersion) throw new Error(`Unsupported ACP protocol version: ${initialized.protocolVersion}.`)
    if (!alive) throw failure ?? new Error('The ACP connection is closed.')
    const call = connection.agent
    return {
      pid: undefined, initialized, get alive() { return alive }, exited, bindSession,
      newSession: (params) => call.request('session/new', params),
      loadSession: (params) => call.request('session/load', params),
      setSessionMode: (params) => call.request('session/set_mode', params),
      setSessionConfigOption: (params) => call.request('session/set_config_option', params),
      prompt: (params) => call.request('session/prompt', params),
      cancel: (sessionId) => call.notify('session/cancel', { sessionId }),
      steer: (params) => call.request<AcpSteerResponse, AcpSteerRequest>(ACP_STEER_METHOD, params),
      stderrTail: () => failure?.message ?? '', dispose
    }
  } catch (error) {
    await dispose()
    // Do not include peer error bodies: a server can echo Authorization there.
    throw failure ?? (error instanceof Error && error.message.startsWith('Unsupported ACP protocol version')
      ? error : new Error('The server did not complete ACP initialization.'))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
