import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechStreamEvent } from '../../shared/speech'

const ipcOnHandlers = new Map<string, (...args: unknown[]) => unknown>()
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { on: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcOnHandlers.set(channel, handler) } }
}))
vi.mock('./_wrap', () => ({ ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler) } }))
const relayUsage = vi.fn(async () => ({ ok: true, enabled: true, usedSeconds: 60, capSeconds: null, periodEnd: '' }))
vi.mock('../speech/coreRelayWiring', () => ({ coreRelayAccess: { usage: () => relayUsage() } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
let activated = true
vi.mock('../auth/activation', () => ({ userActivation: { isActivated: () => activated, requireActivated: () => undefined } }))

const session = { push: vi.fn(), stop: vi.fn(), cancel: vi.fn() }
let sink: ((event: SpeechStreamEvent) => void) | null = null
const openStream = vi.fn((_options: unknown, s: (event: SpeechStreamEvent) => void) => { sink = s; return session })
vi.mock('../speech/speechService', () => ({ speechService: { openStream: (...args: [unknown, (event: SpeechStreamEvent) => void]) => openStream(...args) } }))

const { registerSpeechHandlers, parseSpeechStreamCommand, parseSpeechStreamOptions, MAX_STREAM_CHUNK_BYTES, MAX_REPLAY_SECONDS } = await import('./speech.ipc')
registerSpeechHandlers()

class FakePort extends EventEmitter {
  posted: unknown[] = []
  closed = false
  started = false
  postMessage(message: unknown): void { this.posted.push(message) }
  close(): void { this.closed = true }
  start(): void { this.started = true }
  send(data: unknown): void { this.emit('message', { data, ports: [] }) }
}

function open(options: unknown = { locale: 'en-US' }): FakePort {
  const port = new FakePort()
  ipcOnHandlers.get('speech:stream')?.({ ports: [port] }, options)
  return port
}

beforeEach(() => {
  activated = true
  sink = null
  openStream.mockClear()
  session.push.mockClear(); session.stop.mockClear(); session.cancel.mockClear()
})

describe('parseSpeechStreamCommand', () => {
  it('accepts audio, stop and cancel', () => {
    const pcm = new Uint8Array([1, 2, 3])
    expect(parseSpeechStreamCommand({ type: 'audio', pcm })).toEqual({ type: 'audio', pcm })
    expect(parseSpeechStreamCommand({ type: 'stop' })).toEqual({ type: 'stop' })
    expect(parseSpeechStreamCommand({ type: 'cancel', extra: 1 })).toEqual({ type: 'cancel' })
  })
  it('refuses audio that is not bytes or is over the chunk cap, and anything else', () => {
    expect(parseSpeechStreamCommand({ type: 'audio', pcm: [1, 2] })).toBeNull()
    expect(parseSpeechStreamCommand({ type: 'audio', pcm: new ArrayBuffer(4) })).toBeNull()
    expect(parseSpeechStreamCommand({ type: 'audio', pcm: new Uint8Array(MAX_STREAM_CHUNK_BYTES + 1) })).toBeNull()
    expect(parseSpeechStreamCommand({ type: 'audio', pcm: new Uint8Array(MAX_STREAM_CHUNK_BYTES) })).not.toBeNull()
    expect(parseSpeechStreamCommand({ type: 'start' })).toBeNull()
    expect(parseSpeechStreamCommand(null)).toBeNull()
    expect(parseSpeechStreamCommand('stop')).toBeNull()
  })
})

describe('parseSpeechStreamOptions', () => {
  it('keeps a locale, and the relay engine with its replay seconds', () => {
    expect(parseSpeechStreamOptions({ locale: 'de-DE' })).toEqual({ locale: 'de-DE' })
    expect(parseSpeechStreamOptions({ engine: 'core-relay', replaySeconds: 3.5 })).toEqual({ engine: 'core-relay', replaySeconds: 3.5 })
    expect(parseSpeechStreamOptions({ engine: 'core-relay', replaySeconds: 0 })).toEqual({ engine: 'core-relay', replaySeconds: 0 })
  })
  it('drops any other engine, and replay seconds without the relay engine', () => {
    expect(parseSpeechStreamOptions({ engine: 'gemini-live', replaySeconds: 3 })).toEqual({})
    expect(parseSpeechStreamOptions({ engine: 'macos' })).toEqual({})
    expect(parseSpeechStreamOptions({ replaySeconds: 3 })).toEqual({})
  })
  it('drops malformed replay seconds and caps large ones', () => {
    for (const replaySeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      expect(parseSpeechStreamOptions({ engine: 'core-relay', replaySeconds })).toEqual({ engine: 'core-relay' })
    }
    expect(parseSpeechStreamOptions({ engine: 'core-relay', replaySeconds: 600 })).toEqual({ engine: 'core-relay', replaySeconds: MAX_REPLAY_SECONDS })
  })
  it('reads garbage as no options', () => {
    expect(parseSpeechStreamOptions(null)).toEqual({})
    expect(parseSpeechStreamOptions('core-relay')).toEqual({})
    expect(parseSpeechStreamOptions({ locale: '' })).toEqual({})
  })
})

describe('speech:relay-usage', () => {
  it('answers the relay usage when activated, and data when not', async () => {
    expect(await ipcHandlers.get('speech:relay-usage')?.({})).toMatchObject({ ok: true, usedSeconds: 60 })
    activated = false
    expect(await ipcHandlers.get('speech:relay-usage')?.({})).toMatchObject({ ok: false, message: expect.any(String) })
  })
})

describe('speech:stream', () => {
  it('passes the validated relay options to the service', () => {
    open({ locale: 'en-US', engine: 'core-relay', replaySeconds: 2, extra: 'x' })
    expect(openStream).toHaveBeenCalledWith({ locale: 'en-US', engine: 'core-relay', replaySeconds: 2 }, expect.any(Function))
  })

  it('opens a session with the locale from the payload and forwards commands', () => {
    const port = open({ locale: 'de-DE' })
    expect(port.started).toBe(true)
    expect(openStream).toHaveBeenCalledWith({ locale: 'de-DE' }, expect.any(Function))
    port.send({ type: 'audio', pcm: new Uint8Array([1, 2, 3, 4]).subarray(1, 3) })
    expect(session.push).toHaveBeenCalledWith(Buffer.from([2, 3]))
    port.send({ type: 'stop' })
    expect(session.stop).toHaveBeenCalledTimes(1)
  })

  it('posts events and closes the port after the terminal one', () => {
    const port = open()
    sink?.({ type: 'partial', text: 'hi' })
    expect(port.closed).toBe(false)
    sink?.({ type: 'stop', fullText: 'hi' })
    sink?.({ type: 'partial', text: 'late' })
    expect(port.posted).toEqual([{ type: 'partial', text: 'hi' }, { type: 'stop', fullText: 'hi' }])
    expect(port.closed).toBe(true)
    port.emit('close')
    expect(session.cancel).not.toHaveBeenCalled()
  })

  it('refuses an unactivated session as data and opens nothing', () => {
    activated = false
    const port = open()
    expect(openStream).not.toHaveBeenCalled()
    expect(port.posted).toEqual([{ type: 'error', code: 'failed', message: expect.stringContaining('not activated'), recoverable: false }])
    expect(port.closed).toBe(true)
  })

  it('cancels when the renderer cancels or its port closes', () => {
    const cancelled = open()
    cancelled.send({ type: 'cancel' })
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(cancelled.closed).toBe(true)
    expect(cancelled.posted).toEqual([])

    const gone = open()
    gone.emit('close')
    expect(session.cancel).toHaveBeenCalledTimes(2)
  })

  it('ends the session with an error on an off-contract command', () => {
    const port = open()
    port.send({ type: 'audio', pcm: new Uint8Array(MAX_STREAM_CHUNK_BYTES + 1) })
    expect(session.push).not.toHaveBeenCalled()
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(port.posted).toEqual([{ type: 'error', code: 'failed', message: expect.any(String), recoverable: false }])
    expect(port.closed).toBe(true)
  })
})
