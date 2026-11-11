import { GoogleGenAI, Modality } from '@google/genai'
import type { SpeechStreamEvent, TranscribeFailureCode } from '../../../shared/speech'
import { createLogger } from '../../logger/logger'
import type { EngineStreamOptions, SpeechEngine, SpeechStreamSession } from '../speechEngine'
import { resolveGeminiKey, type GeminiKey } from '../geminiCredentials'

const logger = createLogger('speech-gemini')

export const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live'
const AUDIO_MIME = 'audio/pcm;rate=16000'
/** 16 kHz × 16-bit mono. */
const BYTES_PER_SECOND = 32_000

/**
 * The part of a Live server message this engine reads. Shapes come from a live
 * probe of `gemini-3.5-transcribe-live` (2026-11-11): `interimInputTranscription`
 * is cumulative within one utterance, `inputTranscription` is that utterance's
 * final only, and `voiceActivity` arrives as `{ type }` on the wire although the
 * SDK's type names it `voiceActivityType`; both are read.
 */
export interface LiveMessage {
  setupComplete?: unknown
  serverContent?: {
    interimInputTranscription?: { text?: string }
    inputTranscription?: { text?: string }
  }
  voiceActivity?: { type?: string; voiceActivityType?: string }
  goAway?: { timeLeft?: string }
}

export interface LiveCallbacks {
  onmessage(message: LiveMessage): void
  onerror(error: { message?: string }): void
  onclose(event: { code?: number; reason?: string }): void
}

/** One Live WebSocket, as far as this engine uses it. */
export interface LiveConnection {
  sendRealtimeInput(input: { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean }): void
  close(): void
}

/** Opens one Live connection; resolves once the socket is open (before `setupComplete`). */
export type LiveConnect = (request: { apiKey: string; locale: string; callbacks: LiveCallbacks }) => Promise<LiveConnection>

export interface GeminiLiveDeps {
  /** The chosen provider's key, decrypted for this session only. */
  resolveKey(): Promise<GeminiKey>
  connect: LiveConnect
  /**
   * After `audioStreamEnd`: how long a connection may stay silent (no message)
   * before it is finished with what it said.
   */
  stopTimeoutMs: number
  /** After `audioStreamEnd`: the absolute limit for a connection to finish, however chatty. */
  stopCapMs: number
  /**
   * After `audioStreamEnd`: a connection that is quiet (no interim pending, no
   * open voice activity) and sends nothing for this long has said everything.
   * Every message re-arms it, so utterances still queued on the server land.
   */
  quietGraceMs: number
  /** The same, for a connection whose audio went out in one burst at setup: the server is further behind. */
  burstGraceMs: number
  /** From connect to `setupComplete`. */
  connectTimeoutMs: number
  /** A connection lives about 10 minutes; a fresh one takes over before that. */
  rotateAfterMs: number
  streamMaxSeconds: number
}

const connectGeminiLive: LiveConnect = ({ apiKey, locale, callbacks }) => {
  const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' })
  return ai.live.connect({
    model: GEMINI_TRANSCRIBE_MODEL,
    config: { responseModalities: [Modality.TEXT], inputAudioTranscription: { languageCodes: [locale] } },
    callbacks: {
      onmessage: (message) => callbacks.onmessage(message as unknown as LiveMessage),
      onerror: (error) => callbacks.onerror({ message: error?.message }),
      onclose: (event) => callbacks.onclose({ code: event?.code, reason: event?.reason })
    }
  })
}

const DEFAULT_DEPS: GeminiLiveDeps = {
  resolveKey: resolveGeminiKey,
  connect: connectGeminiLive,
  stopTimeoutMs: 3_000,
  stopCapMs: 10_000,
  quietGraceMs: 300,
  burstGraceMs: 600,
  connectTimeoutMs: 10_000,
  rotateAfterMs: 9.5 * 60_000,
  streamMaxSeconds: 30 * 60
}

/**
 * Gemini Live transcription on the user's own Gemini provider key. Live
 * dictation only: the batch `transcribe` answers `unavailable` (it runs only
 * for a preload without `speech.stream`). The key is decrypted when a session
 * opens, stays in main and is never logged.
 */
export function createGeminiLiveEngine(overrides: Partial<GeminiLiveDeps> = {}): SpeechEngine {
  const deps: GeminiLiveDeps = { ...DEFAULT_DEPS, ...overrides }
  return {
    id: 'gemini',
    // Runnable wherever there is a network; whether a key exists is settled per session.
    probe: async () => ({ supported: true, authorization: 'granted', backend: 'gemini-live' }),
    transcribe: async () => ({
      success: false,
      code: 'unavailable',
      message: 'Gemini transcribes only while you dictate live, which this window does not support. Restart Cinna.'
    }),
    openStream: (options, sink) => openGeminiStream(deps, options, sink)
  }
}

interface Connection {
  /** 1-based, for the log. */
  n: number
  live: LiveConnection | null
  /** `setupComplete` arrived: audio may be sent. */
  ready: boolean
  /** Audio pushed before `ready`. */
  queue: Buffer[]
  /** Asked to end (stop, or rotation); `audioStreamEnd` goes out once ready. */
  ending: boolean
  endSent: boolean
  /** Audio was streaming live when the end was asked, so "nothing pending" can be trusted. */
  streamedBeforeEnd: boolean
  /** Said everything it will say; its socket is closed. */
  done: boolean
  closedByUs: boolean
  /** The current utterance's interim, since the last final. */
  pending: string
  /** Between ACTIVITY_START and ACTIVITY_END. */
  speaking: boolean
  lastError: string
  /** Finished by a timeout rather than by going quiet. Per connection: a handover's timeout says nothing about the stop. */
  timedOut: boolean
  timers: ReturnType<typeof setTimeout>[]
  /** After the end: re-armed by every message. */
  graceTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

type Outcome = 'stop' | 'stop-timeout' | 'cancelled' | `error:${TranscribeFailureCode}`

const UNREACHABLE = "Couldn't reach Gemini. Check the internet connection and try again."
const AUTH_REASON = /api[ _-]?key|unauthenticated|unauthori[sz]ed|permission[ _-]?denied|invalid authentication|credential/i
const QUOTA_REASON = /quota|resource[ _-]?exhausted|\b429\b|rate[ _-]?limit|too many requests/i

/** A server's close reason, short enough for a toast. */
function short(reason: string): string {
  return reason.length > 120 ? `${reason.slice(0, 119)}…` : reason
}

/**
 * One dictation over one or more Live connections. Main keeps the finals so
 * `stop` carries the whole text. A connection is replaced before its ~10
 * minute limit (or on `goAway`): audio goes to the new one, the old one gets
 * `audioStreamEnd`, and the new one's events wait until the old one's last
 * final is out (or it times out), so the text stays in spoken order.
 */
function openGeminiStream(
  deps: GeminiLiveDeps,
  options: EngineStreamOptions,
  sink: (event: SpeechStreamEvent) => void
): SpeechStreamSession {
  const locale = options.locale ?? 'en-US'
  const opened = Date.now()
  const maxBytes = Math.floor(deps.streamMaxSeconds * BYTES_PER_SECOND)
  const finals: string[] = []
  /** Events of `current` held while `draining` still speaks. */
  const held: SpeechStreamEvent[] = []
  let apiKey: string | null = null
  let providerName = ''
  let count = 0
  let current = newConnection()
  let draining: Connection | null = null
  let ended = false
  let stopping = false
  let capped = false
  let bytes = 0
  let partials = 0
  let firstPartialMs: number | null = null
  let rotations = 0

  function newConnection(): Connection {
    count++
    return {
      n: count, live: null, ready: false, queue: [], ending: false, endSent: false, streamedBeforeEnd: false,
      done: false, closedByUs: false, pending: '', speaking: false, lastError: '', timedOut: false,
      timers: [], graceTimer: null, idleTimer: null
    }
  }

  /** Anything the server says may quote the request; the key is in the socket URL. */
  function scrub(text: string): string {
    const clipped = text.slice(0, 300)
    return apiKey ? clipped.split(apiKey).join('[key]') : clipped
  }

  function later(c: Connection, ms: number, run: () => void): void {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    c.timers.push(timer)
  }

  function shut(c: Connection): void {
    c.done = true
    for (const timer of c.timers.splice(0)) clearTimeout(timer)
    if (c.graceTimer) clearTimeout(c.graceTimer)
    if (c.idleTimer) clearTimeout(c.idleTimer)
    c.graceTimer = c.idleTimer = null
    c.queue.length = 0
    if (c.live && !c.closedByUs) {
      c.closedByUs = true
      try { c.live.close() } catch { /* already closed */ }
    }
  }

  function finish(outcome: Outcome, terminal: SpeechStreamEvent | null): void {
    if (ended) return
    ended = true
    shut(current)
    if (draining) shut(draining)
    held.length = 0
    const fullText = finals.join(' ').trim()
    logger.info('speech stream finished', {
      engine: 'gemini',
      backend: 'gemini-live',
      chosenBecause: options.chosenBecause ?? 'unknown',
      seconds: Number((bytes / BYTES_PER_SECOND).toFixed(2)),
      durationMs: Date.now() - opened,
      locale,
      firstPartialMs,
      partials,
      finals: finals.length,
      rotations,
      outcome,
      ...(capped ? { capped: true } : {}),
      characters: fullText.length
    })
    apiKey = null
    if (terminal) sink(terminal.type === 'stop' ? { type: 'stop', fullText } : terminal)
  }

  function fail(code: TranscribeFailureCode, message: string): void {
    finish(`error:${code}`, { type: 'error', code, message, recoverable: false })
  }

  function emit(event: SpeechStreamEvent): void {
    if (ended) return
    if (event.type === 'partial') {
      partials++
      firstPartialMs ??= Date.now() - opened
    }
    if (event.type === 'final') finals.push(event.text)
    sink(event)
  }

  /** The old connection speaks first; the new one's words wait behind it. */
  function route(c: Connection, event: SpeechStreamEvent): void {
    if (ended || c.done) return
    if (c === draining) emit(event)
    else if (c === current) {
      if (draining) held.push(event)
      else emit(event)
    }
  }

  /** The connection has said all it will: its unconfirmed text becomes its last final. */
  function settle(c: Connection): void {
    if (c.done) return
    const tail = c.pending.trim()
    c.pending = ''
    if (tail) route(c, { type: 'final', text: tail })
    shut(c)
    if (c === draining) {
      draining = null
      for (const event of held.splice(0)) emit(event)
    }
    if (stopping && !draining && current.done) finish(current.timedOut ? 'stop-timeout' : 'stop', { type: 'stop', fullText: '' })
  }

  function quiet(c: Connection): boolean {
    return !c.pending && !c.speaking
  }

  function send(c: Connection, input: Parameters<LiveConnection['sendRealtimeInput']>[0]): void {
    try {
      c.live?.sendRealtimeInput(input)
    } catch (err) {
      // The socket is going away; its `onclose` decides what that means.
      logger.debug('gemini live send failed', { connection: c.n, err: scrub(String(err)) })
    }
  }

  function sendAudio(c: Connection, pcm: Buffer): void {
    send(c, { audio: { data: pcm.toString('base64'), mimeType: AUDIO_MIME } })
  }

  function timeOut(c: Connection, why: string, timeoutMs: number): void {
    if (c.done) return
    logger.warn(why, { connection: c.n, timeoutMs })
    c.timedOut = true
    settle(c)
  }

  /**
   * After the end, any message means the server is still talking: wait for a
   * quiet spell with nothing new before settling, and give up after a silence
   * of `stopTimeoutMs`.
   */
  function rearm(c: Connection): void {
    if (!c.endSent || c.done) return
    if (c.graceTimer) clearTimeout(c.graceTimer)
    if (c.idleTimer) clearTimeout(c.idleTimer)
    const grace = c.streamedBeforeEnd ? deps.quietGraceMs : deps.burstGraceMs
    c.graceTimer = setTimeout(() => { c.graceTimer = null; if (quiet(c)) settle(c) }, grace)
    c.graceTimer.unref?.()
    c.idleTimer = setTimeout(() => timeOut(c, 'gemini live went silent after the audio ended', deps.stopTimeoutMs), deps.stopTimeoutMs)
    c.idleTimer.unref?.()
  }

  function sendEnd(c: Connection): void {
    if (!c.ending || c.endSent || !c.ready || !c.live || c.done) return
    c.endSent = true
    send(c, { audioStreamEnd: true })
    later(c, deps.stopCapMs, () => timeOut(c, 'gemini live did not finish after the audio ended', deps.stopCapMs))
    rearm(c)
  }

  function flush(c: Connection): void {
    if (!c.ready || !c.live || c.done) return
    for (const pcm of c.queue.splice(0)) sendAudio(c, pcm)
    sendEnd(c)
  }

  function endConnection(c: Connection): void {
    if (c.ending || c.done) return
    c.ending = true
    c.streamedBeforeEnd = c.ready && !!c.live && c.queue.length === 0
    sendEnd(c)
  }

  function onMessage(c: Connection, message: LiveMessage): void {
    if (ended || c.done) return
    if (message.setupComplete !== undefined) {
      c.ready = true
      flush(c)
    }
    const content = message.serverContent
    const interim = content?.interimInputTranscription?.text
    if (typeof interim === 'string') {
      c.pending = interim
      route(c, { type: 'partial', text: interim })
    }
    const final = content?.inputTranscription?.text
    if (typeof final === 'string') {
      c.pending = ''
      const text = final.trim()
      if (text) route(c, { type: 'final', text })
    }
    const activity = message.voiceActivity?.type ?? message.voiceActivity?.voiceActivityType
    if (activity === 'ACTIVITY_START') c.speaking = true
    if (activity === 'ACTIVITY_END') c.speaking = false
    if (typeof interim === 'string' || typeof final === 'string' || activity) rearm(c)
    if (message.goAway && c === current) rotate('goAway')
  }

  function onClose(c: Connection, event: { code?: number; reason?: string }): void {
    if (c.closedByUs || c.done || ended) return
    c.live = null
    // Closed after it was told to end, or while handing over: keep what it said.
    if (c.endSent || c === draining) { settle(c); return }
    const reason = scrub(event.reason ?? '').trim()
    logger.warn('gemini live connection closed', { connection: c.n, code: event.code, reason, ready: c.ready, error: c.lastError || undefined })
    if (AUTH_REASON.test(reason) || AUTH_REASON.test(c.lastError)) {
      fail('failed', `Gemini rejected the API key of provider ${providerName}. Check it in Settings › AI Credentials.`)
    } else if (QUOTA_REASON.test(reason) || QUOTA_REASON.test(c.lastError)) {
      fail('failed', `Gemini's quota for provider ${providerName} is used up. Check its plan in Google AI Studio, or choose another Gemini provider.`)
    } else if (!c.ready) {
      fail('unavailable', reason ? `Gemini refused to start transcribing: ${short(reason)}` : UNREACHABLE)
    } else {
      fail('failed', reason ? `Gemini stopped transcribing unexpectedly (${short(reason)}).` : 'Gemini stopped transcribing unexpectedly.')
    }
  }

  function connect(c: Connection): void {
    const key = apiKey
    if (!key) return
    later(c, deps.connectTimeoutMs, () => {
      if (c.ready || c.done || ended) return
      logger.warn('gemini live did not set up in time', { connection: c.n, timeoutMs: deps.connectTimeoutMs })
      fail('unavailable', UNREACHABLE)
    })
    later(c, deps.rotateAfterMs, () => { if (c === current) rotate('age') })
    let opening: Promise<LiveConnection>
    try {
      opening = deps.connect({
        apiKey: key,
        locale,
        callbacks: {
          onmessage: (message) => onMessage(c, message),
          onerror: (error) => { c.lastError = scrub(error?.message ?? '') },
          onclose: (event) => onClose(c, event ?? {})
        }
      })
    } catch (err) {
      opening = Promise.reject(err)
    }
    opening.then(
      (live) => {
        if (c.done || ended) {
          try { live.close() } catch { /* already closed */ }
          return
        }
        c.live = live
        flush(c)
      },
      (err: unknown) => {
        if (c.done || ended) return
        const message = scrub(err instanceof Error ? err.message : String(err))
        logger.warn('could not connect to Gemini Live', { connection: c.n, error: message })
        if (AUTH_REASON.test(message)) fail('failed', `Gemini rejected the API key of provider ${providerName}. Check it in Settings › AI Credentials.`)
        else fail('unavailable', UNREACHABLE)
      }
    )
  }

  function rotate(why: 'age' | 'goAway'): void {
    if (ended || stopping || draining || !current.ready) return
    const old = current
    current = newConnection()
    draining = old
    rotations++
    logger.info('gemini live connection rotating', { why, from: old.n, to: current.n })
    connect(current)
    endConnection(old)
  }

  void deps.resolveKey().then(
    (key) => {
      if (ended) return
      if (!key.ok) {
        logger.info('speech stream finished', { engine: 'gemini', backend: 'none', chosenBecause: options.chosenBecause ?? 'unknown', seconds: 0, outcome: 'error:unavailable' })
        ended = true
        sink({ type: 'error', code: 'unavailable', message: key.message, recoverable: false })
        return
      }
      apiKey = key.apiKey
      providerName = key.provider.name
      emit({ type: 'start', backend: 'gemini-live' })
      connect(current)
    },
    () => { if (!ended) fail('unavailable', UNREACHABLE) }
  )

  function stop(): void {
    if (ended || stopping) return
    stopping = true
    endConnection(current)
  }

  return {
    push(pcm) {
      if (ended || stopping || pcm.length === 0) return
      const room = maxBytes - bytes
      const chunk = pcm.length > room ? pcm.subarray(0, room) : pcm
      if (chunk.length > 0) {
        bytes += chunk.length
        if (current.ready && current.live) sendAudio(current, chunk)
        else current.queue.push(Buffer.from(chunk))
      }
      if (bytes >= maxBytes) {
        capped = true
        stop()
      }
    },
    stop,
    cancel() {
      if (ended) return
      finish('cancelled', null)
    }
  }
}
