import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechStreamEvent, SpeechStreamHandle, TranscribeResult } from '../../../../../shared/speech'
import { confirmUnconfirmed, keepUnconfirmed, MAX_UNCONFIRMED_SECONDS, useVoiceRecorder, type DictationCallbacks } from './useVoiceRecorder'

// The audio graph, as far as the hook touches it.
const track = { stop: vi.fn(), label: 'Built-in Microphone', muted: false, readyState: 'live', getSettings: () => ({ sampleRate: 48000, channelCount: 1 }), addEventListener: vi.fn() }
const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
let worklet: { port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } } | null = null
const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = []

class FakeAudioContext {
  sampleRate = 16000
  destination = {}
  audioWorklet = { addModule: vi.fn(async () => {}) }
  close = vi.fn(async () => {})
  constructor() { contexts.push(this) }
  createMediaStreamSource() { return { connect: vi.fn() } }
  createGain() { return { gain: { value: 1 }, connect: vi.fn() } }
}
class FakeWorkletNode {
  port = { onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null }
  constructor() { worklet = this }
  connect() {}
}

const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>()
const transcribe = vi.fn<(request: { wav: Uint8Array }) => Promise<TranscribeResult>>()
// The stream main would answer on: what the hook pushed, and a way to answer it.
let streamed: { emit: (event: SpeechStreamEvent) => void; handle: SpeechStreamHandle & { pushed: Uint8Array[] } } | null = null
const openStream = vi.fn((_options: unknown, onEvent: (event: SpeechStreamEvent) => void) => {
  const handle = { pushed: [] as Uint8Array[], push: vi.fn((pcm: Uint8Array) => { handle.pushed.push(pcm) }), stop: vi.fn(), cancel: vi.fn() }
  streamed = { emit: onEvent, handle }
  return handle
})

beforeEach(() => {
  track.stop.mockReset()
  worklet = null
  contexts.length = 0
  getUserMedia.mockReset().mockResolvedValue(stream)
  transcribe.mockReset()
  openStream.mockClear()
  streamed = null
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices: async () => [] }
  })
  ;(window as unknown as { api: unknown }).api = { speech: { transcribe, stream: openStream }, logger: { log: vi.fn(async () => ({ success: true })) } }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  const onText = vi.fn()
  const onError = vi.fn()
  const dictation = { onSessionStart: vi.fn(), onPartial: vi.fn(), onFinal: vi.fn(), onSessionEnd: vi.fn() } satisfies DictationCallbacks
  const hook = renderHook(() => useVoiceRecorder({ deviceId: null, onText, onError, dictation }))
  return { onText, onError, dictation, hook }
}

async function record(hook: ReturnType<typeof setup>['hook'], samples: number): Promise<void> {
  act(() => hook.result.current.toggle())
  await waitFor(() => expect(worklet).not.toBeNull())
  await waitFor(() => expect(hook.result.current.state).toBe('recording'))
  act(() => worklet!.port.onmessage!({ data: new Float32Array(samples).fill(0.5) } as MessageEvent<Float32Array>))
}

describe('useVoiceRecorder, streaming', () => {
  it('opens the stream before the mic and sends audio in 100 ms chunks of 16-bit PCM', async () => {
    const { dictation, hook } = setup()
    await record(hook, 3500)
    expect(dictation.onSessionStart).toHaveBeenCalledTimes(1)
    expect(openStream.mock.invocationCallOrder[0]).toBeLessThan(getUserMedia.mock.invocationCallOrder[0])
    expect(streamed!.handle.pushed.map((chunk) => chunk.byteLength)).toEqual([3200, 3200])
    expect(new Int16Array(streamed!.handle.pushed[0].buffer)[0]).toBe(Math.round(0.5 * 0x7fff - 0.5))
  })

  it('hands partials and finals over, flushes the tail on stop and ends on the engine stop', async () => {
    const { dictation, onError, hook } = setup()
    await record(hook, 5000)
    act(() => streamed!.emit({ type: 'start', backend: 'sfspeech' }))
    act(() => streamed!.emit({ type: 'partial', text: 'hello wor' }))
    act(() => streamed!.emit({ type: 'final', text: 'Hello world.' }))
    expect(dictation.onPartial).toHaveBeenCalledWith('hello wor')
    expect(dictation.onFinal).toHaveBeenCalledWith('Hello world.')
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(streamed!.handle.stop).toHaveBeenCalled())
    await waitFor(() => expect(hook.result.current.state).toBe('transcribing'))
    // 5000 samples: three full chunks while recording, the 200-sample tail on stop.
    expect(streamed!.handle.pushed.map((chunk) => chunk.byteLength)).toEqual([3200, 3200, 3200, 400])
    expect(track.stop).toHaveBeenCalled()
    act(() => streamed!.emit({ type: 'stop', fullText: 'Hello world.' }))
    expect(dictation.onSessionEnd).toHaveBeenCalledWith(true)
    expect(hook.result.current.state).toBe('idle')
    expect(onError).not.toHaveBeenCalledWith(expect.any(String))
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('ends on a fatal error, shows it, and ignores anything after', async () => {
    const { dictation, onError, hook } = setup()
    await record(hook, 2000)
    act(() => streamed!.emit({ type: 'error', code: 'failed', message: 'It broke.', recoverable: false }))
    expect(onError).toHaveBeenCalledWith('It broke.')
    expect(dictation.onSessionEnd).toHaveBeenCalledWith(false)
    expect(hook.result.current.state).toBe('idle')
    expect(track.stop).toHaveBeenCalled()
    act(() => streamed!.emit({ type: 'final', text: 'late' }))
    expect(dictation.onFinal).not.toHaveBeenCalled()
  })

  describe('an offer to continue on the Cinna server', () => {
    const OFFER = { engine: 'core-relay' as const, serverName: 'Acme' }
    function setupWithOffer() {
      const onText = vi.fn()
      const onError = vi.fn()
      const onOffer = vi.fn()
      const dictation = { onSessionStart: vi.fn(), onPartial: vi.fn(), onFinal: vi.fn(), onSessionEnd: vi.fn(), onOffer } satisfies DictationCallbacks
      const hook = renderHook(() => useVoiceRecorder({ deviceId: null, onText, onError, dictation }))
      return { onText, onError, hook, dictation, onOffer }
    }
    const block = (samples: number, value = 0.5): void => {
      act(() => worklet!.port.onmessage!({ data: new Float32Array(samples).fill(value) } as MessageEvent<Float32Array>))
    }

    it('keeps the audio since the last final and hands it over instead of the error', async () => {
      const { onOffer, onError, dictation, hook } = setupWithOffer()
      await record(hook, 3200)
      act(() => streamed!.emit({ type: 'final', text: 'Confirmed.' }))
      // After the final: two full chunks and a 100-sample tail not yet sent.
      block(3300, 0.25)
      act(() => streamed!.emit({ type: 'error', code: 'failed', message: 'It broke.', recoverable: false, offer: OFFER }))
      expect(onError).not.toHaveBeenCalledWith('It broke.')
      expect(dictation.onSessionEnd).toHaveBeenCalledWith(false)
      expect(dictation.onSessionEnd.mock.invocationCallOrder[0]).toBeLessThan(onOffer.mock.invocationCallOrder[0])
      const offer = onOffer.mock.calls[0][0]
      expect(offer).toMatchObject({ message: 'It broke.', serverName: 'Acme', stopped: false })
      // The final kept only its last second (here the 0.2 s before it), then what came after, the unsent tail included.
      expect(offer.replay.map((chunk: Uint8Array) => chunk.byteLength)).toEqual([3200, 3200, 3200, 3200, 200])
      expect(offer.replaySeconds).toBe(0.4)
      expect(hook.result.current.state).toBe('idle')
    })

    it('a final drops what it confirmed but the last second, so words spoken while it was in flight are replayed', async () => {
      const { onOffer, hook } = setupWithOffer()
      // 3 s before the final: 30 chunks of 100 ms.
      await record(hook, 48_000)
      act(() => streamed!.emit({ type: 'final', text: 'Confirmed.' }))
      block(1600, 0.25)
      act(() => streamed!.emit({ type: 'error', code: 'failed', message: 'It broke.', recoverable: false, offer: OFFER }))
      const offer = onOffer.mock.calls[0][0]
      // The last second before the final (10 chunks), then the chunk after it.
      expect(offer.replay).toHaveLength(11)
      expect(offer.replaySeconds).toBe(1.1)
    })

    it('a continuation after stop waits longer for a long replay', async () => {
      const { onOffer, onError, hook } = setupWithOffer()
      await record(hook, 3200)
      act(() => streamed!.emit({ type: 'error', code: 'failed', message: 'It broke.', recoverable: false, offer: OFFER }))
      expect(onOffer).toHaveBeenCalled()
      vi.useFakeTimers()
      try {
        // 60 s replayed: the server has 30 s more than the plain 20 s to finish.
        act(() => hook.result.current.continueOnRelay({ replay: [new Uint8Array(60 * 32_000)], replaySeconds: 60, stopped: true }))
        expect(hook.result.current.state).toBe('transcribing')
        act(() => { vi.advanceTimersByTime(50_000) })
        expect(onError).not.toHaveBeenCalledWith('Transcription took too long.')
        act(() => { vi.advanceTimersByTime(5_001) })
        expect(onError).toHaveBeenCalledWith('Transcription took too long.')
      } finally {
        vi.useRealTimers()
      }
    })

    it('continueOnRelay while a dictation runs says so instead of dropping the replay', async () => {
      const { onError, hook } = setupWithOffer()
      await record(hook, 3200)
      openStream.mockClear()
      act(() => hook.result.current.continueOnRelay({ replay: [new Uint8Array(3200)], replaySeconds: 0.1, stopped: false }))
      expect(onError).toHaveBeenCalledWith('A dictation is already running.')
      expect(openStream).not.toHaveBeenCalled()
    })

    it('without an onOffer handler an offer is a plain error', async () => {
      const { onError, hook } = setup()
      await record(hook, 2000)
      act(() => streamed!.emit({ type: 'error', code: 'failed', message: 'It broke.', recoverable: false, offer: OFFER }))
      expect(onError).toHaveBeenCalledWith('It broke.')
    })

    it('continueOnRelay opens the relay stream with replaySeconds, replays first, then streams the mic', async () => {
      const { onOffer, dictation, hook } = setupWithOffer()
      await record(hook, 3200)
      act(() => streamed!.emit({ type: 'error', code: 'unavailable', message: 'Gone.', recoverable: false, offer: OFFER }))
      const offer = onOffer.mock.calls[0][0]
      worklet = null
      openStream.mockClear()
      act(() => hook.result.current.continueOnRelay({ replay: offer.replay, replaySeconds: offer.replaySeconds, stopped: false }))
      expect(openStream).toHaveBeenCalledWith({ engine: 'core-relay', replaySeconds: 0.2 }, expect.any(Function))
      expect(dictation.onSessionStart).toHaveBeenCalledTimes(2)
      expect(streamed!.handle.pushed).toEqual(offer.replay)
      await waitFor(() => expect(worklet).not.toBeNull())
      block(1600, 0.75)
      // The replayed 0.2 s, then the live chunk.
      expect(streamed!.handle.pushed.map((chunk) => chunk.byteLength)).toEqual([3200, 3200, 3200])
      expect(new Int16Array(streamed!.handle.pushed[2].buffer)[0]).toBe(Math.round(0.75 * 0x7fff - 0.5))
      expect(hook.result.current.state).toBe('recording')
    })

    it('an offer after the user stopped continues without the mic and finishes', async () => {
      const { onOffer, hook } = setupWithOffer()
      await record(hook, 5000)
      act(() => hook.result.current.toggle())
      await waitFor(() => expect(streamed!.handle.stop).toHaveBeenCalled())
      act(() => streamed!.emit({ type: 'error', code: 'failed', message: 'It broke.', recoverable: false, offer: OFFER }))
      const offer = onOffer.mock.calls[0][0]
      expect(offer.stopped).toBe(true)
      getUserMedia.mockClear()
      act(() => hook.result.current.continueOnRelay({ replay: offer.replay, replaySeconds: offer.replaySeconds, stopped: true }))
      expect(streamed!.handle.pushed.map((chunk) => chunk.byteLength)).toEqual([3200, 3200, 3200, 400])
      expect(streamed!.handle.stop).toHaveBeenCalled()
      expect(hook.result.current.state).toBe('transcribing')
      expect(getUserMedia).not.toHaveBeenCalled()
    })
  })

  it('only logs a recoverable error', async () => {
    const { dictation, onError, hook } = setup()
    await record(hook, 2000)
    act(() => streamed!.emit({ type: 'error', code: 'failed', message: 'Hiccup.', recoverable: true }))
    expect(onError).not.toHaveBeenCalledWith('Hiccup.')
    expect(dictation.onSessionEnd).not.toHaveBeenCalled()
    expect(hook.result.current.state).toBe('recording')
  })

  it('end() cancels at once and drops whatever the engine sends later', async () => {
    const { dictation, hook } = setup()
    await record(hook, 2000)
    act(() => hook.result.current.end())
    expect(streamed!.handle.cancel).toHaveBeenCalled()
    expect(dictation.onSessionEnd).toHaveBeenCalledWith(false)
    expect(hook.result.current.state).toBe('idle')
    act(() => streamed!.emit({ type: 'partial', text: 'late' }))
    expect(dictation.onPartial).not.toHaveBeenCalled()
  })

  it('calls a stray click nothing and cancels the stream', async () => {
    const { dictation, onError, hook } = setup()
    await record(hook, 1000)
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Nothing was recorded.'))
    expect(streamed!.handle.cancel).toHaveBeenCalled()
    expect(streamed!.handle.stop).not.toHaveBeenCalled()
    expect(dictation.onSessionEnd).toHaveBeenCalledWith(false)
  })

  it('cancels on unmount while recording', async () => {
    const { dictation, hook } = setup()
    await record(hook, 2000)
    hook.unmount()
    expect(streamed!.handle.cancel).toHaveBeenCalled()
    expect(dictation.onSessionEnd).toHaveBeenCalledWith(false)
  })

  it('lets the last words land after an unmount while finishing', async () => {
    const { dictation, hook } = setup()
    await record(hook, 5000)
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(streamed!.handle.stop).toHaveBeenCalled())
    hook.unmount()
    expect(streamed!.handle.cancel).not.toHaveBeenCalled()
    streamed!.emit({ type: 'final', text: 'last words' })
    streamed!.emit({ type: 'stop', fullText: 'last words' })
    expect(dictation.onFinal).toHaveBeenCalledWith('last words')
    expect(dictation.onSessionEnd).toHaveBeenCalledWith(true)
  })

  it('records whole and transcribes on stop without dictation callbacks', async () => {
    const onText = vi.fn()
    transcribe.mockResolvedValue({ success: true, text: 'batch words' })
    const hook = renderHook(() => useVoiceRecorder({ deviceId: null, onText, onError: vi.fn() }))
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(worklet).not.toBeNull())
    act(() => worklet!.port.onmessage!({ data: new Float32Array(8000) } as MessageEvent<Float32Array>))
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(onText).toHaveBeenCalledWith('batch words'))
    expect(openStream).not.toHaveBeenCalled()
  })
})

describe('confirmUnconfirmed', () => {
  it('keeps the newest chunks that make up the kept span, and drops the rest', () => {
    const live = { unconfirmed: [] as Uint8Array[], unconfirmedBytes: 0 }
    for (let i = 1; i <= 5; i++) keepUnconfirmed(live, new Uint8Array(10).fill(i))
    confirmUnconfirmed(live, 25)
    expect(live.unconfirmed.map((chunk) => chunk[0])).toEqual([3, 4, 5])
    expect(live.unconfirmedBytes).toBe(30)
    confirmUnconfirmed(live, 0)
    expect(live.unconfirmed).toEqual([])
    expect(live.unconfirmedBytes).toBe(0)
  })
})

describe('keepUnconfirmed', () => {
  it('drops the oldest chunks past the cap, never the newest', () => {
    const live = { unconfirmed: [] as Uint8Array[], unconfirmedBytes: 0 }
    for (let i = 1; i <= 4; i++) keepUnconfirmed(live, new Uint8Array(10).fill(i), 25)
    expect(live.unconfirmed.map((chunk) => chunk[0])).toEqual([3, 4])
    expect(live.unconfirmedBytes).toBe(20)
    keepUnconfirmed(live, new Uint8Array(40).fill(9), 25)
    expect(live.unconfirmed.map((chunk) => chunk[0])).toEqual([9])
  })

  it('holds 60 seconds by default', () => {
    const live = { unconfirmed: [] as Uint8Array[], unconfirmedBytes: 0 }
    for (let i = 0; i < 700; i++) keepUnconfirmed(live, new Uint8Array(3200))
    expect(live.unconfirmedBytes).toBe(MAX_UNCONFIRMED_SECONDS * 32_000)
  })
})
