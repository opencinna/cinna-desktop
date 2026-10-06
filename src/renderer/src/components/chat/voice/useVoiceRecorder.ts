import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscribeResult } from '../../../../../shared/speech'
import { unwrapIpcError } from '../../../utils/ipcError'
import workletUrl from './recorderWorklet.js?url&no-inline'
import { concatSamples, encodeWav } from './wav'

export type VoiceRecorderState = 'idle' | 'recording' | 'transcribing'

const SAMPLE_RATE = 16000
/** Shorter than this is a stray click, not a recording. */
const MIN_SAMPLES = SAMPLE_RATE / 4

interface Session {
  stream: MediaStream | null
  context: AudioContext | null
  chunks: Float32Array[]
  /** Stop was asked for, or the component unmounted, while the mic was still opening. */
  stopped: boolean
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

type SpeechApi = { transcribe?: (request: { wav: Uint8Array; locale?: string }) => Promise<TranscribeResult> }

/**
 * Click-to-record, click-to-transcribe. Records mono 16 kHz through an
 * AudioWorklet, encodes a WAV on stop and asks main to transcribe it. idle →
 * recording → transcribing → idle. The mic and the audio context are released
 * on stop and on unmount; unmounting mid-recording discards the recording. A
 * transcription already in flight still delivers its text, since `onText`
 * writes the composer's draft, which outlives the component.
 */
export function useVoiceRecorder({
  deviceId,
  onText,
  onError
}: {
  deviceId: string | null
  onText: (text: string) => void
  onError: (message: string | null) => void
}): {
  state: VoiceRecorderState
  /** The live state, ahead of `state` between a transition and its render. */
  current: () => VoiceRecorderState
  toggle: () => void
} {
  const [state, setState] = useState<VoiceRecorderState>('idle')
  const stateRef = useRef<VoiceRecorderState>('idle')
  const sessionRef = useRef<Session | null>(null)
  const mounted = useRef(true)
  const callbacks = useRef({ onText, onError, deviceId })
  callbacks.current = { onText, onError, deviceId }

  const move = useCallback((next: VoiceRecorderState) => {
    stateRef.current = next
    if (mounted.current) setState(next)
  }, [])

  const start = useCallback(async () => {
    const session: Session = { stream: null, context: null, chunks: [], stopped: false }
    sessionRef.current = session
    callbacks.current.onError(null)
    move('recording')
    try {
      session.stream = await openMic(callbacks.current.deviceId)
      if (session.stopped) return releaseSession(session)
      const context = new AudioContext({ sampleRate: SAMPLE_RATE })
      session.context = context
      await context.audioWorklet.addModule(workletUrl)
      if (session.stopped) return releaseSession(session)
      const source = context.createMediaStreamSource(session.stream)
      const node = new AudioWorkletNode(context, 'cinna-recorder')
      node.port.onmessage = (event: MessageEvent<Float32Array>) => { session.chunks.push(event.data) }
      // Pulled through a silent gain to the destination, so the graph runs
      // without playing the mic back.
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(context.destination)
    } catch (err) {
      releaseSession(session)
      if (sessionRef.current === session) sessionRef.current = null
      if (!session.stopped) {
        move('idle')
        callbacks.current.onError(micErrorMessage(err))
      }
    }
  }, [move])

  const stop = useCallback(async () => {
    const session = sessionRef.current
    sessionRef.current = null
    if (!session) return move('idle')
    session.stopped = true
    // The worklet's last blocks are already queued on the port; let them land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const rate = session.context?.sampleRate ?? SAMPLE_RATE
    releaseSession(session)
    const samples = concatSamples(session.chunks)
    if (samples.length < MIN_SAMPLES) {
      move('idle')
      callbacks.current.onError('Nothing was recorded.')
      return
    }
    move('transcribing')
    try {
      const speech = (window.api as { speech?: SpeechApi }).speech
      if (typeof speech?.transcribe !== 'function') throw new Error('Audio input is not available.')
      const result = await speech.transcribe({ wav: encodeWav(samples, rate) })
      if (result.success) callbacks.current.onText(result.text)
      else callbacks.current.onError(result.message)
    } catch (err) {
      callbacks.current.onError(unwrapIpcError(err, 'Transcription failed'))
    } finally {
      move('idle')
    }
  }, [move])

  const toggle = useCallback(() => {
    if (stateRef.current === 'idle') void start()
    else if (stateRef.current === 'recording') void stop()
  }, [start, stop])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const session = sessionRef.current
      sessionRef.current = null
      if (session) {
        session.stopped = true
        releaseSession(session)
      }
    }
  }, [])

  const current = useCallback(() => stateRef.current, [])
  return { state, current, toggle }
}
