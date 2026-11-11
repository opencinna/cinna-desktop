import WebSocket from 'ws'
import type { SpeechStreamEvent, TranscribeFailureCode } from '../../../shared/speech'
import { createLogger } from '../../logger/logger'
import type { EngineStreamOptions, SpeechEngine, SpeechStreamSession } from '../speechEngine'

const logger = createLogger('speech-core')

/** 16 kHz × 16-bit mono. */
const BYTES_PER_SECOND = 32_000
/** Protocol v1: a binary frame carries at most 64 KB. */
export const RELAY_MAX_FRAME_BYTES = 65_536

/** Where one session goes, and with what; or why it cannot. The token never leaves main and is never logged. */
export type RelayTarget =
  | { ok: true; url: string; token: string; serverName: string }
  | { ok: false; code: TranscribeFailureCode; message: string }

export interface CoreRelayDeps {
  /** The relay URL of the active profile's server and a fresh access token for it. */
  resolveTarget(): Promise<RelayTarget>
  /** The server answered `disabled`: its availability is worth reading again. */
  onDisabled(): void
  /** From the session's start (token, target, connect) to the socket being open. */
  connectTimeoutMs: number
  /**
   * From the stop frame being sent, how long the server has to answer `stop`,
   * plus {@link CoreRelayDeps.stopTimeoutPerReplaySecondMs} for each replayed
   * second it still has to transcribe. Before the socket is open the connect
   * timeout bounds the wait instead.
   */
  stopTimeoutMs: number
  stopTimeoutPerReplaySecondMs: number
  streamMaxSeconds: number
}

const DEFAULT_DEPS: Omit<CoreRelayDeps, 'resolveTarget' | 'onDisabled'> = {
  connectTimeoutMs: 10_000,
  stopTimeoutMs: 10_000,
  stopTimeoutPerReplaySecondMs: 500,
  streamMaxSeconds: 30 * 60
}

/** Server error codes (protocol v1) onto the client's. */
const CODE_MAP: Record<string, TranscribeFailureCode> = {
  busy: 'busy',
  disabled: 'unavailable',
  unavailable: 'unavailable',
  quota_exceeded: 'unavailable',
  unauthorized: 'failed',
  failed: 'failed',
  bad_request: 'failed'
}

export const RELAY_CONNECTION_LOST = 'The connection to the Cinna server was lost.'

/** The longest replay a continuation sends (the renderer keeps no more), which bounds the stop budget. */
export const RELAY_MAX_REPLAY_SECONDS = 60

/** BCP-47 locale tags are well under this; anything longer is not one. */
const MAX_LOCALE_LENGTH = 35

/**
 * The first candidate that reads as a BCP-47 locale, normalised (`en_US.UTF-8`
 * → `en-US`), else `en-US`. Candidates in order: the requested locale, the
 * on-device engine's, the system's.
 */
export function pickRelayLocale(candidates: readonly (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const normalised = normaliseLocale(candidate)
    if (normalised) return normalised
  }
  return 'en-US'
}

function normaliseLocale(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  // POSIX spellings: `en_US.UTF-8`, `de_DE@euro`.
  const tag = value.trim().split(/[.@]/)[0].replace(/_/g, '-')
  if (!tag || tag.length > MAX_LOCALE_LENGTH) return null
  try {
    const [canonical] = Intl.getCanonicalLocales(tag)
    return canonical && canonical.length <= MAX_LOCALE_LENGTH && canonical.toLowerCase() !== 'und' ? canonical : null
  } catch {
    return null
  }
}

function didNotAnswer(serverName: string): string {
  return `${serverName} did not finish transcribing. Try again.`
}

export function relaySignInAgain(serverName: string): string {
  return `Your session on ${serverName} has expired. Sign in again, then try once more.`
}

function unreachable(serverName: string): string {
  return `Couldn't reach ${serverName}. Check the connection and try again.`
}

/** The host of a URL, for the log: never its path or query. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}

/**
 * Dictation through the voice transcription relay of the profile's Cinna
 * server (protocol v1). Live only: the batch `transcribe` answers
 * `unavailable`. Main opens the socket itself with the profile's access token
 * as a Bearer header at the upgrade, never in the URL.
 */
export function createCoreRelayEngine(deps: Pick<CoreRelayDeps, 'resolveTarget' | 'onDisabled'> & Partial<CoreRelayDeps>): SpeechEngine {
  const full: CoreRelayDeps = { ...DEFAULT_DEPS, ...deps }
  return {
    id: 'core',
    // Runnable wherever there is a network; whether the server offers it is settled by the caller.
    probe: async () => ({ supported: true, authorization: 'granted', backend: 'core-relay' }),
    transcribe: async () => ({
      success: false,
      code: 'unavailable',
      message: 'The Cinna server transcribes only while you dictate live, which this window does not support. Restart Cinna.'
    }),
    openStream: (options, sink) => openRelayStream(full, options, sink)
  }
}

type Outcome = 'stop' | 'stop-timeout' | 'cancelled' | `error:${TranscribeFailureCode}`

function openRelayStream(
  deps: CoreRelayDeps,
  options: EngineStreamOptions,
  sink: (event: SpeechStreamEvent) => void
): SpeechStreamSession {
  const locale = pickRelayLocale([options.locale])
  const replaySeconds = typeof options.replaySeconds === 'number' && Number.isFinite(options.replaySeconds) && options.replaySeconds > 0
    ? Math.min(options.replaySeconds, RELAY_MAX_REPLAY_SECONDS)
    : 0
  const stopBudgetMs = deps.stopTimeoutMs + Math.round(replaySeconds * deps.stopTimeoutPerReplaySecondMs)
  const opened = Date.now()
  const maxBytes = Math.floor(deps.streamMaxSeconds * BYTES_PER_SECOND)
  const finals: string[] = []
  const queue: Buffer[] = []
  const timers: ReturnType<typeof setTimeout>[] = []
  let socket: WebSocket | null = null
  let open = false
  let ended = false
  let stopping = false
  let stopSent = false
  let capped = false
  let bytes = 0
  let partials = 0
  let firstPartialMs: number | null = null
  let remainingSeconds: number | null | undefined
  let host = 'none'
  let serverName = 'the Cinna server'

  function later(ms: number, run: () => void): void {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    timers.push(timer)
  }

  function closeSocket(): void {
    const ws = socket
    socket = null
    open = false
    if (!ws) return
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000)
      else ws.terminate()
    } catch {
      /* already closed */
    }
  }

  function finish(outcome: Outcome, terminal: SpeechStreamEvent | null): void {
    if (ended) return
    ended = true
    for (const timer of timers.splice(0)) clearTimeout(timer)
    queue.length = 0
    closeSocket()
    const fullText = terminal?.type === 'stop' ? terminal.fullText : finals.join(' ').trim()
    logger.info('speech stream finished', {
      engine: 'core',
      backend: 'core-relay',
      host,
      chosenBecause: options.chosenBecause ?? 'unknown',
      seconds: Number((bytes / BYTES_PER_SECOND).toFixed(2)),
      replaySeconds: Number(replaySeconds.toFixed(2)),
      durationMs: Date.now() - opened,
      locale,
      firstPartialMs,
      partials,
      finals: finals.length,
      outcome,
      ...(remainingSeconds !== undefined ? { remainingSeconds } : {}),
      ...(capped ? { capped: true } : {}),
      characters: fullText.length
    })
    if (terminal) sink(terminal)
  }

  function fail(code: TranscribeFailureCode, message: string): void {
    finish(`error:${code}`, { type: 'error', code, message, recoverable: false })
  }

  function sendJson(frame: Record<string, unknown>): void {
    try {
      socket?.send(JSON.stringify(frame))
    } catch (err) {
      // The socket is going away; its `close` decides what that means.
      logger.debug('relay send failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  function sendAudio(pcm: Buffer): void {
    for (let offset = 0; offset < pcm.length; offset += RELAY_MAX_FRAME_BYTES) {
      const frame = pcm.subarray(offset, offset + RELAY_MAX_FRAME_BYTES)
      try {
        socket?.send(frame, { binary: true })
      } catch (err) {
        logger.debug('relay send failed', { error: err instanceof Error ? err.message : String(err) })
        return
      }
    }
  }

  /**
   * The stop budget starts here, when the server is actually told: token
   * refresh, connecting and the replay burst before it are not the server's
   * delay (the connect timeout, counted from the session's start, bounds
   * the time before the socket opens).
   */
  function sendStop(): void {
    if (!open || stopSent || ended) return
    stopSent = true
    sendJson({ type: 'stop' })
    later(stopBudgetMs, () => {
      if (ended) return
      logger.warn('relay did not finish after the audio ended', { host, timeoutMs: stopBudgetMs, finals: finals.length })
      // Finals mean it was answering: end with them. None at all: it never answered, which is a failure, not an empty dictation.
      if (finals.length > 0) finish('stop-timeout', { type: 'stop', fullText: finals.join(' ').trim() })
      else fail('failed', didNotAnswer(serverName))
    })
  }

  function onServerFrame(raw: string): void {
    let frame: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      frame = parsed as Record<string, unknown>
    } catch {
      logger.debug('relay sent a frame that is not JSON')
      return
    }
    switch (frame.type) {
      case 'start':
        remainingSeconds = typeof frame.remaining_seconds === 'number' ? frame.remaining_seconds : null
        return
      case 'partial':
        if (typeof frame.text !== 'string') return
        partials++
        firstPartialMs ??= Date.now() - opened
        sink({ type: 'partial', text: frame.text })
        return
      case 'final': {
        if (typeof frame.text !== 'string') return
        const text = frame.text.trim()
        if (!text) return
        finals.push(text)
        sink({ type: 'final', text })
        return
      }
      case 'stop': {
        const fullText = typeof frame.full_text === 'string' ? frame.full_text : finals.join(' ').trim()
        finish('stop', { type: 'stop', fullText })
        return
      }
      case 'error': {
        const serverCode = typeof frame.code === 'string' ? frame.code : 'failed'
        const code = CODE_MAP[serverCode] ?? 'failed'
        const message = typeof frame.message === 'string' && frame.message.trim()
          ? frame.message.trim()
          : `${serverName} stopped transcribing unexpectedly.`
        logger.warn('relay answered an error', { serverCode })
        if (serverCode === 'disabled') deps.onDisabled()
        fail(code, message)
        return
      }
      default:
        return
    }
  }

  function connect(url: string, token: string): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: false })
    } catch (err) {
      logger.warn('could not open the relay socket', { host, error: err instanceof Error ? err.message : String(err) })
      fail('failed', unreachable(serverName))
      return
    }
    socket = ws
    let lastError = ''
    ws.on('open', () => {
      if (ended || socket !== ws) return
      open = true
      sendJson({ type: 'start', version: 1, locale, sample_rate: 16_000, replay_seconds: replaySeconds })
      for (const pcm of queue.splice(0)) sendAudio(pcm)
      if (stopping) sendStop()
    })
    ws.on('message', (data, isBinary) => {
      if (ended || socket !== ws || isBinary) return
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      onServerFrame(bytes.toString('utf8'))
    })
    // A refused upgrade (failed auth closes with 1008 before the accept, which
    // reaches a client as an HTTP 403) never becomes an open socket.
    ws.on('unexpected-response', (request, response) => {
      const status = response.statusCode ?? 0
      response.resume()
      request.destroy()
      if (ended || socket !== ws) return
      logger.warn('relay refused the connection', { host, status })
      if (status === 401 || status === 403) fail('failed', relaySignInAgain(serverName))
      else fail('unavailable', `Transcription through ${serverName} is not available right now (HTTP ${status}).`)
    })
    ws.on('error', (err) => {
      lastError = err instanceof Error ? err.message : String(err)
    })
    ws.on('close', (code) => {
      if (ended || socket !== ws) return
      const wasOpen = open
      open = false
      logger.warn('relay connection closed without an answer', { host, code, wasOpen, error: lastError || undefined })
      if (code === 1008) fail('failed', relaySignInAgain(serverName))
      else if (!wasOpen) fail('failed', unreachable(serverName))
      else fail('failed', RELAY_CONNECTION_LOST)
    })
  }

  // One budget from the session's start to an open socket: the token (which
  // may refresh over the network), the discovery read and the connect.
  later(deps.connectTimeoutMs, () => {
    if (open || ended) return
    logger.warn('relay socket did not open in time', { host, timeoutMs: deps.connectTimeoutMs })
    fail('failed', unreachable(serverName))
  })
  void deps.resolveTarget().then(
    (target) => {
      if (ended) return
      if (!target.ok) {
        fail(target.code, target.message)
        return
      }
      host = hostOf(target.url)
      serverName = target.serverName
      sink({ type: 'start', backend: 'core-relay' })
      connect(target.url, target.token)
    },
    (err: unknown) => {
      if (ended) return
      logger.warn('could not prepare the relay session', { error: err instanceof Error ? err.message : String(err) })
      fail('failed', 'Could not start transcribing on the Cinna server.')
    }
  )

  function stop(): void {
    if (ended || stopping) return
    stopping = true
    sendStop()
  }

  return {
    push(pcm) {
      if (ended || stopping || pcm.length === 0) return
      const room = maxBytes - bytes
      const chunk = pcm.length > room ? pcm.subarray(0, room) : pcm
      if (chunk.length > 0) {
        bytes += chunk.length
        if (open) sendAudio(chunk)
        else queue.push(Buffer.from(chunk))
      }
      if (bytes >= maxBytes) {
        capped = true
        stop()
      }
    },
    stop,
    cancel() {
      if (ended) return
      if (open) sendJson({ type: 'cancel' })
      finish('cancelled', null)
    }
  }
}
