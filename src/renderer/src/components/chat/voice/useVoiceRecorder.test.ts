import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscribeResult } from '../../../../../shared/speech'
import { useVoiceRecorder } from './useVoiceRecorder'

// The audio graph, as far as the hook touches it.
const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] } as unknown as MediaStream
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

beforeEach(() => {
  track.stop.mockReset()
  worklet = null
  contexts.length = 0
  getUserMedia.mockReset().mockResolvedValue(stream)
  transcribe.mockReset()
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices: async () => [] }
  })
  ;(window as unknown as { api: unknown }).api = { speech: { transcribe } }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  const onText = vi.fn()
  const onError = vi.fn()
  const hook = renderHook(() => useVoiceRecorder({ deviceId: null, onText, onError }))
  return { onText, onError, hook }
}

/** Starts recording and waits for the worklet to be listening. */
async function record(hook: ReturnType<typeof setup>['hook'], samples: number): Promise<void> {
  act(() => hook.result.current.toggle())
  await waitFor(() => expect(worklet).not.toBeNull())
  await waitFor(() => expect(hook.result.current.state).toBe('recording'))
  worklet!.port.onmessage!({ data: new Float32Array(samples) } as MessageEvent<Float32Array>)
}

describe('useVoiceRecorder', () => {
  it('calls a recording shorter than a quarter second nothing, and never transcribes it', async () => {
    const { onError, hook } = setup()
    await record(hook, 16000 / 4 - 1)
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Nothing was recorded.'))
    await waitFor(() => expect(hook.result.current.state).toBe('idle'))
    expect(transcribe).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalled()
  })

  it('transcribes a real recording and hands the text over', async () => {
    transcribe.mockResolvedValue({ success: true, text: 'hello there' })
    const { onText, onError, hook } = setup()
    await record(hook, 16000)
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(onText).toHaveBeenCalledWith('hello there'))
    await waitFor(() => expect(hook.result.current.state).toBe('idle'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(null)
  })

  it('explains a denied microphone and goes back to idle', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const { onError, hook } = setup()
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('Microphone access is off')))
    expect(onError.mock.calls[0]).toEqual([null])
    await waitFor(() => expect(hook.result.current.state).toBe('idle'))
    expect(contexts).toHaveLength(0)
  })

  it('unmounted while the mic opens, stops the tracks and reports nothing', async () => {
    let open!: (value: MediaStream) => void
    getUserMedia.mockReturnValue(new Promise((resolve) => { open = resolve }))
    const { onError, hook } = setup()
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
    hook.unmount()
    await act(async () => { open(stream) })
    await waitFor(() => expect(track.stop).toHaveBeenCalled())
    expect(contexts).toHaveLength(0)
    expect(onError.mock.calls).toEqual([[null]])
  })

  it('unmounted while transcribing, still delivers the text', async () => {
    let finish!: (result: TranscribeResult) => void
    transcribe.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { onText, onError, hook } = setup()
    await record(hook, 16000)
    act(() => hook.result.current.toggle())
    await waitFor(() => expect(transcribe).toHaveBeenCalled())
    await waitFor(() => expect(hook.result.current.state).toBe('transcribing'))
    hook.unmount()
    await act(async () => { finish({ success: true, text: 'kept' }) })
    expect(onText).toHaveBeenCalledWith('kept')
    expect(onError.mock.calls).toEqual([[null]])
  })
})
