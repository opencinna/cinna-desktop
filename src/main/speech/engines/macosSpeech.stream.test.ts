import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechStreamEvent } from '../../../shared/speech'
import { createMacosSpeechEngine, parseStreamLine, type HelperRun, type MacosSpeechDeps, type StreamChild } from './macosSpeech'

/** A `cinna-speech stream` stand-in: the test prints its stdout lines and decides how it exits. */
class FakeChild extends EventEmitter {
  written: Buffer[] = []
  stdinEnded = false
  killed: (NodeJS.Signals | undefined)[] = []
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (chunk: Buffer) => { this.written.push(Buffer.from(chunk)); return true },
    end: () => { this.stdinEnded = true }
  })
  kill(signal?: NodeJS.Signals): boolean { this.killed.push(signal); return true }
  print(...lines: string[]): void { this.stdout.emit('data', Buffer.from(lines.map((l) => `${l}\n`).join(''))) }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void { this.emit('close', code, signal) }
  get bytes(): number { return this.written.reduce((n, b) => n + b.length, 0) }
}

function setup(over: Partial<MacosSpeechDeps> = {}): {
  child: FakeChild
  events: SpeechStreamEvent[]
  spawn: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  open: (locale?: string) => ReturnType<ReturnType<typeof createMacosSpeechEngine>['openStream']>
} {
  const child = new FakeChild()
  const events: SpeechStreamEvent[] = []
  const spawn = vi.fn(() => child as unknown as StreamChild)
  const run = vi.fn(async (): Promise<HelperRun> => ({ stdout: '{"ok":true}' }))
  const engine = createMacosSpeechEngine({
    platform: 'darwin',
    helperPath: () => '/app/resources/speech/cinna-speech',
    exists: () => true,
    run,
    spawn,
    streamMaxSeconds: 60,
    streamStopTimeoutMs: 10_000,
    ...over
  })
  return { child, events, spawn, run, open: (locale) => engine.openStream({ locale }, (e) => events.push(e)) }
}

afterEach(() => { vi.useRealTimers() })

describe('parseStreamLine', () => {
  it('reads every event the helper prints', () => {
    expect(parseStreamLine('{"type":"start","backend":"sfspeech"}')).toEqual({ type: 'start', backend: 'sfspeech', installModel: false })
    expect(parseStreamLine('{"type":"start","backend":"sfspeech","installModel":true}')).toMatchObject({ installModel: true })
    expect(parseStreamLine('{"type":"partial","text":" Let\'s "}')).toEqual({ type: 'partial', text: "Let's" })
    expect(parseStreamLine('{"type":"final","text":"Done."}')).toEqual({ type: 'final', text: 'Done.' })
    expect(parseStreamLine('{"type":"engine-change","backend":"sfspeech","reason":"no format"}')).toEqual({ type: 'engine-change', backend: 'sfspeech', reason: 'no format' })
    expect(parseStreamLine('{"type":"error","code":"denied","message":"off"}')).toEqual({ type: 'error', code: 'denied', message: 'off', installModel: false })
    expect(parseStreamLine('{"type":"done"}')).toEqual({ type: 'done' })
  })
  it('skips framework noise and malformed or unknown lines', () => {
    expect(parseStreamLine('2026-11-10 cinna-speech[123] No Assistant asset')).toBeNull()
    expect(parseStreamLine('{"type":"partial"')).toBeNull()
    expect(parseStreamLine('{"type":"partial","text":5}')).toBeNull()
    expect(parseStreamLine('{"type":"start","backend":"whisper"}')).toBeNull()
    expect(parseStreamLine('{"type":"surprise"}')).toBeNull()
    expect(parseStreamLine('[1,2]')).toBeNull()
  })
  it('folds an unknown error code into failed', () => {
    expect(parseStreamLine('{"type":"error","code":"exploded"}')).toEqual({ type: 'error', code: 'failed', message: 'Speech recognition failed.', installModel: false })
  })
})

describe('macOS stream session', () => {
  it('spawns the stream command, pipes audio and ends with every final joined', () => {
    const { child, events, spawn, open } = setup()
    const session = open('en-US')
    expect(spawn).toHaveBeenCalledWith('/app/resources/speech/cinna-speech', ['stream', '--locale', 'en-US'])
    session.push(Buffer.alloc(3200, 1))
    expect(child.bytes).toBe(3200)
    child.print('{"type":"start","backend":"sfspeech"}', 'noise from a framework', '{"type":"partial","text":"Let\'s"}')
    child.print('{"type":"final","text":"Let\'s check."}', '{"type":"partial","text":"And"}')
    session.stop()
    expect(child.stdinEnded).toBe(true)
    // A line split across two reads.
    child.stdout.emit('data', Buffer.from('{"type":"final","te'))
    child.stdout.emit('data', Buffer.from('xt":"And this."}\n{"type":"done"}\n'))
    child.exit(0)
    expect(events).toEqual([
      { type: 'start', backend: 'sfspeech' },
      { type: 'partial', text: "Let's" },
      { type: 'final', text: "Let's check." },
      { type: 'partial', text: 'And' },
      { type: 'final', text: 'And this.' },
      { type: 'stop', fullText: "Let's check. And this." }
    ])
  })

  it('keeps a multi-byte character that a read splits in two', () => {
    const { child, events, open } = setup()
    const session = open('de-DE')
    const line = Buffer.from('{"type":"final","text":"Grüße"}\n{"type":"done"}\n')
    const cut = line.indexOf(Buffer.from('ü')) + 1
    child.stdout.emit('data', line.subarray(0, cut))
    child.stdout.emit('data', line.subarray(cut))
    session.stop()
    child.exit(0)
    expect(events).toContainEqual({ type: 'final', text: 'Grüße' })
    expect(events.at(-1)).toEqual({ type: 'stop', fullText: 'Grüße' })
  })

  it('passes engine-change through and ends on a helper error', () => {
    const { child, events, open } = setup()
    open()
    child.print('{"type":"start","backend":"analyzer"}', '{"type":"engine-change","backend":"sfspeech","reason":"setup"}')
    child.print('{"type":"error","code":"failed","message":"boom"}', '{"type":"partial","text":"late"}')
    child.exit(0)
    expect(events).toEqual([
      { type: 'start', backend: 'analyzer' },
      { type: 'engine-change', backend: 'sfspeech', reason: 'setup' },
      { type: 'error', code: 'failed', message: 'boom', recoverable: false }
    ])
  })

  it('reports a crash while recording as a non-recoverable error, SIGABRT as the usage-description case', () => {
    const plain = setup()
    plain.open()
    plain.child.print('{"type":"start","backend":"sfspeech"}', '{"type":"partial","text":"hello"}')
    plain.child.exit(null, 'SIGSEGV')
    expect(plain.events.at(-1)).toEqual({ type: 'error', code: 'failed', message: 'Speech recognition stopped unexpectedly.', recoverable: false })
    expect(plain.events.filter((e) => e.type === 'final' || e.type === 'stop')).toEqual([])

    const abort = setup()
    abort.open()
    abort.child.exit(null, 'SIGABRT')
    expect(abort.events).toEqual([{ type: 'error', code: 'failed', message: expect.stringContaining('usage description'), recoverable: false }])
  })

  it('promotes the pending partial when the helper exits without done after stop', () => {
    const { child, events, open } = setup()
    const session = open()
    child.print('{"type":"final","text":"One."}', '{"type":"partial","text":"two three"}')
    session.stop()
    child.exit(null, 'SIGSEGV')
    expect(events).toEqual([
      { type: 'final', text: 'One.' },
      { type: 'partial', text: 'two three' },
      { type: 'final', text: 'two three' },
      { type: 'stop', fullText: 'One. two three' }
    ])
  })

  it('stops on its own and kills the helper when done never comes after the audio ended', () => {
    vi.useFakeTimers()
    const { child, events, open } = setup()
    const session = open()
    child.print('{"type":"partial","text":"almost"}')
    session.stop()
    vi.advanceTimersByTime(9_999)
    expect(events.at(-1)).toEqual({ type: 'partial', text: 'almost' })
    vi.advanceTimersByTime(1)
    expect(events.slice(-2)).toEqual([{ type: 'final', text: 'almost' }, { type: 'stop', fullText: 'almost' }])
    expect(child.killed).toEqual(['SIGTERM'])
    child.print('{"type":"done"}')
    child.exit(null, 'SIGTERM')
    expect(events).toHaveLength(3)
  })

  it('sends nothing after cancel and kills the helper', () => {
    const { child, events, open } = setup()
    const session = open()
    child.print('{"type":"start","backend":"sfspeech"}')
    session.cancel()
    expect(child.killed).toEqual(['SIGTERM'])
    session.push(Buffer.alloc(10))
    session.stop()
    child.print('{"type":"partial","text":"late"}', '{"type":"done"}')
    child.exit(null, 'SIGTERM')
    expect(events).toEqual([{ type: 'start', backend: 'sfspeech' }])
    expect(child.bytes).toBe(0)
    expect(child.stdinEnded).toBe(false)
  })

  it('stops itself at the length cap and ignores audio past it', () => {
    const { child, events, open } = setup({ streamMaxSeconds: 0.1 })
    const session = open()
    session.push(Buffer.alloc(2000))
    session.push(Buffer.alloc(2000))
    expect(child.bytes).toBe(3200)
    expect(child.stdinEnded).toBe(true)
    session.push(Buffer.alloc(2000))
    expect(child.bytes).toBe(3200)
    child.print('{"type":"final","text":"capped"}', '{"type":"done"}')
    expect(events.at(-1)).toEqual({ type: 'stop', fullText: 'capped' })
  })

  it('starts one model install when start asks for it', () => {
    const { child, run, open } = setup()
    open('de-DE')
    child.print('{"type":"start","backend":"sfspeech","installModel":true}')
    expect(run).toHaveBeenCalledWith('/app/resources/speech/cinna-speech', ['install', '--locale', 'de-DE'], 15 * 60_000)
  })

  it('answers unavailable without spawning off macOS or without the helper', () => {
    for (const over of [{ platform: 'linux' as const }, { exists: () => false }]) {
      const { events, spawn, open } = setup(over)
      const session = open()
      expect(events).toEqual([{ type: 'error', code: 'unavailable', message: expect.any(String), recoverable: false }])
      session.stop()
      expect(spawn).not.toHaveBeenCalled()
    }
  })

  it('reports a spawn failure once', () => {
    const { child, events, open } = setup()
    open()
    child.emit('error', new Error('spawn EACCES'))
    child.exit(-2)
    expect(events).toEqual([{ type: 'error', code: 'failed', message: 'Speech recognition could not start.', recoverable: false }])
  })
})
