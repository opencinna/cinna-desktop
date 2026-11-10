import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SpeechBackend,
  SpeechStreamEvent,
  SpeechStreamHandle,
  SpeechStreamOptions,
  TranscribeResult
} from '../../../../../shared/speech'
import { unwrapIpcError } from '../../../utils/ipcError'
import workletUrl from './recorderWorklet.js?url&no-inline'
import { concatSamples, encodeWav, sampleLevels } from './wav'
import { createLogger } from '../../../stores/logger.store'

const logger = createLogger('voice')

export type VoiceRecorderState = 'idle' | 'recording' | 'transcribing'

const SAMPLE_RATE = 16000
/** Shorter than this is a stray click, not a recording. */
const MIN_SAMPLES = SAMPLE_RATE / 4
/** Streamed audio goes to main in chunks of this many samples (100 ms). */
const STREAM_CHUNK_SAMPLES = SAMPLE_RATE / 10
/** After stop, how long to wait for the engine's last words before giving up. */
const FINISH_TIMEOUT_MS = 20_000

/** Running levels, so a streamed recording need not keep its samples for the log line. */
interface Levels {
  samples: number
  chunks: number
  peak: number
  sumSquares: number
}

interface Session {
  stream: MediaStream | null
  context: AudioContext | null
  /** Batch mode: every block, joined and encoded on stop. */
  chunks: Float32Array[]
  /** Stop was asked for, or the component unmounted, while the mic was still opening. */
  stopped: boolean
  /** Streaming mode: main's end of the session. */
  live: LiveSession | null
}

interface LiveSession {
  handle: SpeechStreamHandle
  levels: Levels
  /** Samples waiting to fill a chunk. */
  pending: Int16Array
  pendingLength: number
  /** The engine answered `stop` or a fatal error, or the user froze or cancelled: ignore anything later. */
  ended: boolean
  finishTimer: ReturnType<typeof setTimeout> | null
  backend: SpeechBackend | null
}

function releaseSession(session: Session): void {
  session.stream?.getTracks().forEach((track) => track.stop())
  session.stream = null
  void session.context?.close().catch(() => {})
  session.context = null
}

/** The chosen mic when it is still plugged in; otherwise the system default. */
async function audioConstraints(deviceId: string | null): Promise<MediaTrackConstraints | true> {
  if (!deviceId) return true
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    if (!devices.some((device) => device.kind === 'audioinput' && device.deviceId === deviceId)) return true
  } catch {
    return true
  }
  return { deviceId: { exact: deviceId } }
}

async function openMic(deviceId: string | null): Promise<MediaStream> {
  const audio = await audioConstraints(deviceId)
  try {
    return await navigator.mediaDevices.getUserMedia({ audio })
  } catch (err) {
    // Unplugged between the check and the open: fall back to the default.
    if (audio !== true && err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      logger.warn('chosen microphone failed to open, using the default', { error: err.name })
      return navigator.mediaDevices.getUserMedia({ audio: true })
    }
    throw err
  }
}

function micErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return 'Microphone access is off. Allow Cinna in System Settings › Privacy & Security › Microphone.'
    }
    if (err.name === 'NotFoundError') return 'No microphone was found.'
    if (err.name === 'NotReadableError') return 'The microphone is in use or unavailable.'
  }
  return `Could not start recording: ${unwrapIpcError(err, 'unknown error')}`
}

type SpeechApi = {
  transcribe?: (request: { wav: Uint8Array; locale?: string }) => Promise<TranscribeResult>
  stream?: (options: SpeechStreamOptions, onEvent: (event: SpeechStreamEvent) => void) => SpeechStreamHandle
}

function speechApi(): SpeechApi | undefined {
  return (window.api as { speech?: SpeechApi } | undefined)?.speech
}

/** Float samples in [-1, 1] → 16-bit PCM, appended to the session's pending chunk. */
export function appendPcm(live: Pick<LiveSession, 'pending' | 'pendingLength'>, block: Float32Array): Int16Array[] {
  const full: Int16Array[] = []
  for (let i = 0; i < block.length; i++) {
    const s = Math.max(-1, Math.min(1, block[i]))
    live.pending[live.pendingLength++] = s < 0 ? s * 0x8000 : s * 0x7fff
    if (live.pendingLength === live.pending.length) {
      full.push(live.pending)
      live.pending = new Int16Array(live.pending.length)
      live.pendingLength = 0
    }
  }
  return full
}

function pcmBytes(samples: Int16Array, length = samples.length): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, length * 2).slice()
}

function noteLevels(levels: Levels, block: Float32Array): void {
  levels.chunks++
  levels.samples += block.length
  for (let i = 0; i < block.length; i++) {
    const v = Math.abs(block[i])
    if (v > levels.peak) levels.peak = v
    levels.sumSquares += block[i] * block[i]
  }
}

/** What the composer hears from a streamed dictation. */
export interface DictationCallbacks {
  /** Recording started (before any audio): the composer fixes where the text goes. */
  onSessionStart: () => void
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  /** The session is over: normally, or after a freeze, cancel or failure. `completed` only for the engine's own `stop`. */
  onSessionEnd: (completed: boolean) => void
}

/**
 * Click-to-record. Records mono 16 kHz through an AudioWorklet. Where main
 * offers `speech.stream`, the audio streams to it while the user speaks and
 * the text arrives as partials and finals (idle → recording → transcribing
 * while the last words finalize → idle). Without it, the batch path: a WAV on
 * stop, transcribed whole. The mic and the audio context are released on stop
 * and on unmount. Unmounting mid-recording discards what was not yet
 * confirmed; a stop already in flight still delivers its text, since the
 * callbacks write the composer's draft, which outlives the component.
 */
export function useVoiceRecorder({
  deviceId,
  onText,
  onError,
  dictation
}: {
  deviceId: string | null
  onText: (text: string) => void
  onError: (message: string | null) => void
  dictation?: DictationCallbacks
}): {
  state: VoiceRecorderState
  /** The live state, ahead of `state` between a transition and its render. */
  current: () => VoiceRecorderState
  toggle: () => void
  /** Streaming only: stop listening now and keep what is shown (`freeze`) or only what is confirmed (`cancel`). */
  end: () => void
} {
  const [state, setState] = useState<VoiceRecorderState>('idle')
  const stateRef = useRef<VoiceRecorderState>('idle')
  const sessionRef = useRef<Session | null>(null)
  const mounted = useRef(true)
  const callbacks = useRef({ onText, onError, deviceId, dictation })
  callbacks.current = { onText, onError, deviceId, dictation }

  const move = useCallback((next: VoiceRecorderState) => {
    stateRef.current = next
    if (mounted.current) setState(next)
  }, [])

  /** Ends a streamed session for good; `completed` when the engine said `stop`. */
  const finishLive = useCallback((session: Session, completed: boolean) => {
    const live = session.live
    if (!live || live.ended) return
    live.ended = true
    if (live.finishTimer) clearTimeout(live.finishTimer)
    session.stopped = true
    releaseSession(session)
    if (sessionRef.current === session) sessionRef.current = null
    // Before idle, as the batch path delivers its text before idle: a pending
    // send-after-text is consumed by the time idle renders.
    callbacks.current.dictation?.onSessionEnd(completed)
    move('idle')
  }, [move])

  const onStreamEvent = useCallback((session: Session, event: SpeechStreamEvent) => {
    const live = session.live
    if (!live || live.ended) return
    const dictation = callbacks.current.dictation
    switch (event.type) {
      case 'start':
        live.backend = event.backend
        logger.info('dictation engine started', { backend: event.backend })
        return
      case 'engine-change':
        live.backend = event.backend
        logger.warn('dictation engine changed', { backend: event.backend, reason: event.reason })
        return
      case 'partial':
        dictation?.onPartial(event.text)
        return
      case 'final':
        dictation?.onFinal(event.text)
        return
      case 'stop':
        logger.info('dictation finished', { backend: live.backend, characters: event.fullText.length })
        finishLive(session, true)
        return
      case 'error':
        if (event.recoverable) {
          logger.warn('dictation engine reported a recoverable error', { code: event.code, message: event.message })
          return
        }
        logger.warn('dictation failed', { code: event.code, message: event.message })
        finishLive(session, false)
        callbacks.current.onError(event.message)
    }
  }, [finishLive])

  const start = useCallback(async () => {
    const session: Session = { stream: null, context: null, chunks: [], stopped: false, live: null }
    sessionRef.current = session
    callbacks.current.onError(null)
    const api = speechApi()
    const streaming = !!callbacks.current.dictation && typeof api?.stream === 'function'
    move('recording')
    if (streaming && api?.stream) {
      // Opened before the mic, so the engine starts while the mic warms up.
      const live: LiveSession = {
        handle: null as unknown as SpeechStreamHandle,
        levels: { samples: 0, chunks: 0, peak: 0, sumSquares: 0 },
        pending: new Int16Array(STREAM_CHUNK_SAMPLES),
        pendingLength: 0,
        ended: false,
        finishTimer: null,
        backend: null
      }
      session.live = live
      callbacks.current.dictation?.onSessionStart()
      live.handle = api.stream({}, (event) => onStreamEvent(session, event))
    }
    try {
      session.stream = await openMic(callbacks.current.deviceId)
      const track = session.stream.getAudioTracks()[0]
      if (track) {
        const { sampleRate, channelCount } = track.getSettings()
        logger.info('microphone opened', {
          device: track.label || '(no label)',
          chosen: callbacks.current.deviceId !== null,
          streaming,
          sampleRate,
          channelCount,
          muted: track.muted,
          readyState: track.readyState
        })
        // macOS mutes or ends the track when it cuts the mic off mid-recording.
        track.addEventListener('mute', () => {
          if (!session.stopped) logger.warn('microphone track muted', { device: track.label })
        })
        track.addEventListener('unmute', () => {
          if (!session.stopped) logger.info('microphone track unmuted', { device: track.label })
        })
        track.addEventListener('ended', () => {
          if (!session.stopped) logger.warn('microphone track ended while recording', { device: track.label })
        })
      } else {
        logger.warn('microphone stream has no audio track')
      }
      if (session.stopped) return releaseSession(session)
      const context = new AudioContext({ sampleRate: SAMPLE_RATE })
      session.context = context
      await context.audioWorklet.addModule(workletUrl)
      if (session.stopped) return releaseSession(session)
      const source = context.createMediaStreamSource(session.stream)
      const node = new AudioWorkletNode(context, 'cinna-recorder')
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const live = session.live
        if (!live) {
          session.chunks.push(event.data)
          return
        }
        if (live.ended || session.stopped) return
        noteLevels(live.levels, event.data)
        for (const chunk of appendPcm(live, event.data)) live.handle.push(pcmBytes(chunk))
      }
      // Pulled through a silent gain to the destination, so the graph runs
      // without playing the mic back.
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(context.destination)
    } catch (err) {
      logger.warn('could not start recording', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
      releaseSession(session)
      if (session.live && !session.live.ended) {
        session.live.handle.cancel()
        finishLive(session, false)
        callbacks.current.onError(micErrorMessage(err))
        return
      }
      if (sessionRef.current === session) sessionRef.current = null
      if (!session.stopped) {
        move('idle')
        callbacks.current.onError(micErrorMessage(err))
      }
    }
  }, [move, onStreamEvent, finishLive])

  /** Streaming: no more audio; the engine finalizes and answers `stop`. */
  const stopLive = useCallback(async (session: Session, live: LiveSession) => {
    // The worklet's last blocks are already queued on the port; let them land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (live.ended) return
    session.stopped = true
    releaseSession(session)
    if (live.pendingLength > 0) live.handle.push(pcmBytes(live.pending, live.pendingLength))
    live.pendingLength = 0
    const { samples, chunks, peak, sumSquares } = live.levels
    const recorded = {
      seconds: Number((samples / SAMPLE_RATE).toFixed(2)),
      chunks,
      peak: Number(peak.toFixed(4)),
      rms: Number(Math.sqrt(samples ? sumSquares / samples : 0).toFixed(4))
    }
    if (chunks === 0) logger.warn('recording got no audio from the recorder', recorded)
    else if (peak === 0) logger.warn('recording is silent (peak below 0.0001)', recorded)
    else logger.info('recording stopped', recorded)
    if (samples < MIN_SAMPLES) {
      live.handle.cancel()
      finishLive(session, false)
      callbacks.current.onError('Nothing was recorded.')
      return
    }
    move('transcribing')
    live.handle.stop()
    live.finishTimer = setTimeout(() => {
      if (live.ended) return
      logger.warn('dictation did not finish in time')
      live.handle.cancel()
      finishLive(session, false)
      callbacks.current.onError('Transcription took too long.')
    }, FINISH_TIMEOUT_MS)
  }, [move, finishLive])

  const stop = useCallback(async () => {
    const session = sessionRef.current
    if (!session) return move('idle')
    if (session.live) {
      if (session.live.ended || stateRef.current !== 'recording') return
      return stopLive(session, session.live)
    }
    sessionRef.current = null
    session.stopped = true
    // The worklet's last blocks are already queued on the port; let them land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const rate = session.context?.sampleRate ?? SAMPLE_RATE
    releaseSession(session)
    const samples = concatSamples(session.chunks)
    const levels = sampleLevels(samples)
    const recorded = { seconds: Number((samples.length / rate).toFixed(2)), sampleRate: rate, chunks: session.chunks.length, ...levels }
    // No chunks: the audio graph never ran. A zero peak: the mic delivered
    // (near) zeros, as macOS does without permission or from the wrong device.
    if (recorded.chunks === 0) logger.warn('recording got no audio from the recorder', recorded)
    else if (levels.peak === 0) logger.warn('recording is silent (peak below 0.0001)', recorded)
    else logger.info('recording stopped', recorded)
    if (samples.length < MIN_SAMPLES) {
      move('idle')
      callbacks.current.onError('Nothing was recorded.')
      return
    }
    move('transcribing')
    try {
      const speech = speechApi()
      if (typeof speech?.transcribe !== 'function') throw new Error('Audio input is not available.')
      const result = await speech.transcribe({ wav: encodeWav(samples, rate) })
      if (result.success) callbacks.current.onText(result.text)
      else {
        logger.warn('transcription failed', { code: result.code, message: result.message })
        callbacks.current.onError(result.message)
      }
    } catch (err) {
      callbacks.current.onError(unwrapIpcError(err, 'Transcription failed'))
    } finally {
      move('idle')
    }
  }, [move, stopLive])

  /** Streaming: stop listening at once; whatever the composer keeps is its call. */
  const end = useCallback(() => {
    const session = sessionRef.current
    const live = session?.live
    if (!session || !live || live.ended) return
    live.handle.cancel()
    finishLive(session, false)
  }, [finishLive])

  const toggle = useCallback(() => {
    if (stateRef.current === 'idle') void start()
    else if (stateRef.current === 'recording') void stop()
  }, [start, stop])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const session = sessionRef.current
      if (!session) return
      // Finishing: let the last words land in the draft, which outlives this.
      if (session.live && !session.live.ended && stateRef.current === 'transcribing') return
      sessionRef.current = null
      session.stopped = true
      releaseSession(session)
      if (session.live && !session.live.ended) {
        session.live.handle.cancel()
        session.live.ended = true
        if (session.live.finishTimer) clearTimeout(session.live.finishTimer)
        callbacks.current.dictation?.onSessionEnd(false)
      }
    }
  }, [])

  const current = useCallback(() => stateRef.current, [])
  return { state, current, toggle, end }
}
