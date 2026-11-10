import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechStreamEvent, SpeechStreamHandle, TranscribeResult } from '../../../../../shared/speech'
import { useVoiceRecorder, type DictationCallbacks } from './useVoiceRecorder'

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
