import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechStreamEvent } from '../../../shared/speech'

const logged = vi.hoisted(() => [] as { message: string; data: unknown }[])
vi.mock('../../logger/logger', () => ({
  createLogger: () => {
    const log = (message: string, data?: unknown): void => { logged.push({ message, data }) }
    return { debug: log, info: log, warn: log, error: log }
  }
}))
// The default key resolver reads the database; every test injects its own.
vi.mock('../geminiCredentials', () => ({ resolveGeminiKey: async () => ({ ok: false, message: 'none' }) }))

const { createGeminiLiveEngine } = await import('./geminiLive')
type Deps = Parameters<typeof createGeminiLiveEngine>[0]
type Callbacks = import('./geminiLive').LiveCallbacks

const KEY = 'AIza-secret-key'

/** One fake Live socket: what was sent to it, and the server's side to drive. */
class FakeConnection {
  sent: ({ audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean })[] = []
  closed = false
  constructor(readonly callbacks: Callbacks, readonly locale: string) {}
  sendRealtimeInput(input: { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean }): void { this.sent.push(input) }
  close(): void { this.closed = true }
  get audio(): string[] { return this.sent.filter((s) => s.audio).map((s) => Buffer.from(s.audio!.data, 'base64').toString()) }
  get ended(): boolean { return this.sent.some((s) => s.audioStreamEnd) }
  setup(): void { this.callbacks.onmessage({ setupComplete: {} }) }
  interim(text: string): void { this.callbacks.onmessage({ serverContent: { interimInputTranscription: { text } } }) }
  final(text: string): void { this.callbacks.onmessage({ serverContent: { inputTranscription: { text } } }) }
  activity(type: 'ACTIVITY_START' | 'ACTIVITY_END'): void { this.callbacks.onmessage({ voiceActivity: { type } }) }
  /** The tick the probe saw after an utterance: final, generationComplete, ACTIVITY_END. */
  utteranceEnd(text: string): void {
    this.final(text)
    this.callbacks.onmessage({ serverContent: {} })
    this.activity('ACTIVITY_END')
  }
  serverClose(code: number, reason = ''): void { this.callbacks.onclose({ code, reason }) }
}

function setup(over: Partial<NonNullable<Deps>> = {}) {
  const connections: FakeConnection[] = []
  const events: SpeechStreamEvent[] = []
  const connect = vi.fn(async ({ apiKey, locale, callbacks }: { apiKey: string; locale: string; callbacks: Callbacks }) => {
    expect(apiKey).toBe(KEY)
    const connection = new FakeConnection(callbacks, locale)
    connections.push(connection)
    return connection
  })
  const engine = createGeminiLiveEngine({
    resolveKey: async () => ({ ok: true, apiKey: KEY, provider: { id: 'g1', name: 'Work Gemini' } }),
    connect,
    ...over
  })
  const session = engine.openStream({ locale: 'de-DE', chosenBecause: 'always' }, (e) => events.push(e))
  const pcm = (text: string): void => session.push(Buffer.from(text))
  return { engine, session, events, connections, connect, pcm }
}

/** Lets the key resolution and `connect` promises settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function terminals(events: SpeechStreamEvent[]): SpeechStreamEvent[] {
  return events.filter((e) => e.type === 'stop' || (e.type === 'error' && !e.recoverable))
}

beforeEach(() => {
  vi.useFakeTimers()
  logged.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('geminiLive engine', () => {
  it('starts with the gemini-live backend and the locale, and queues audio until setupComplete', async () => {
    const { connections, events, pcm } = setup()
    pcm('a')
    await flush()
    expect(events).toEqual([{ type: 'start', backend: 'gemini-live' }])
    const [c] = connections
    expect(c.locale).toBe('de-DE')
    pcm('b')
    expect(c.sent).toEqual([])
    c.setup()
    expect(c.audio).toEqual(['a', 'b'])
    expect(c.sent[0].audio?.mimeType).toBe('audio/pcm;rate=16000')
    pcm('c')
    expect(c.audio).toEqual(['a', 'b', 'c'])
  })

  it('maps cumulative interims to partials and per-utterance finals to finals, across utterances', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.activity('ACTIVITY_START')
    c.interim("Let's")
    c.interim("Let's check")
    c.utteranceEnd("Let's check it.")
    c.activity('ACTIVITY_START')
    c.interim('This')
    c.utteranceEnd('This one.')
    session.stop()
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([
      { type: 'start', backend: 'gemini-live' },
      { type: 'partial', text: "Let's" },
      { type: 'partial', text: "Let's check" },
      { type: 'final', text: "Let's check it." },
      { type: 'partial', text: 'This' },
      { type: 'final', text: 'This one.' },
      { type: 'stop', fullText: "Let's check it. This one." }
    ])
  })

  it('keeps a final that differs from the last interim', async () => {
    const { connections, events } = setup()
    await flush()
    connections[0].setup()
    connections[0].interim('product name, SynaDesk')
    connections[0].final('product name, Cynos Desktop.')
    expect(events.at(-1)).toEqual({ type: 'final', text: 'product name, Cynos Desktop.' })
  })

  it('on stop with speech pending: sends audioStreamEnd and finishes once quiet after the final, then closes the socket', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.activity('ACTIVITY_START')
    c.interim('half a')
    session.stop()
    expect(c.ended).toBe(true)
    expect(terminals(events)).toEqual([])
    await vi.advanceTimersByTimeAsync(300)
    c.utteranceEnd('half a sentence.')
    expect(terminals(events)).toEqual([])
    await vi.advanceTimersByTimeAsync(300)
    expect(events.slice(-2)).toEqual([{ type: 'final', text: 'half a sentence.' }, { type: 'stop', fullText: 'half a sentence.' }])
    expect(c.closed).toBe(true)
  })

  it('on stop with voice activity still open but no interim yet: waits for ACTIVITY_END', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.activity('ACTIVITY_START')
    session.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(terminals(events)).toEqual([])
    c.activity('ACTIVITY_END')
    await vi.advanceTimersByTimeAsync(300)
    expect(events.at(-1)).toEqual({ type: 'stop', fullText: '' })
  })

  it('on stop with nothing pending: finishes after the short grace', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.activity('ACTIVITY_START')
    c.utteranceEnd('Done.')
    session.stop()
    expect(terminals(events)).toEqual([])
    await vi.advanceTimersByTimeAsync(300)
    expect(events.at(-1)).toEqual({ type: 'stop', fullText: 'Done.' })
    expect(c.closed).toBe(true)
  })

  it('a stop before setupComplete keeps every utterance the burst produces, in order', async () => {
    const { connections, events, session, pcm } = setup()
    pcm('a')
    session.stop()
    await flush()
    const [c] = connections
    expect(c.sent).toEqual([])
    c.setup()
    expect(c.audio).toEqual(['a'])
    expect(c.ended).toBe(true)
    // The server is still working through the burst: a quiet moment shorter than the burst grace is not the end.
    await vi.advanceTimersByTimeAsync(500)
    c.activity('ACTIVITY_START')
    c.interim('First')
    c.utteranceEnd('First.')
    await vi.advanceTimersByTimeAsync(500)
    c.activity('ACTIVITY_START')
    c.utteranceEnd('Second.')
    await vi.advanceTimersByTimeAsync(400)
    c.activity('ACTIVITY_START')
    c.utteranceEnd('Third.')
    expect(terminals(events)).toEqual([])
    await vi.advanceTimersByTimeAsync(600)
    expect(events.filter((e) => e.type === 'final')).toEqual([
      { type: 'final', text: 'First.' }, { type: 'final', text: 'Second.' }, { type: 'final', text: 'Third.' }
    ])
    expect(events.at(-1)).toEqual({ type: 'stop', fullText: 'First. Second. Third.' })
    expect(logged.find((l) => l.message === 'speech stream finished')?.data).toMatchObject({ outcome: 'stop' })
  })

  it('utterances still queued on the server after a live stop all land, in order', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.activity('ACTIVITY_START')
    c.interim('one')
    session.stop()
    c.utteranceEnd('One.')
    await vi.advanceTimersByTimeAsync(200)
    c.activity('ACTIVITY_START')
    c.utteranceEnd('Two.')
    await vi.advanceTimersByTimeAsync(300)
    expect(events.at(-1)).toEqual({ type: 'stop', fullText: 'One. Two.' })
  })

  it('a silent quick tap that stops before setup ends within the burst grace, not on the timeout', async () => {
    const { connections, events, session, pcm } = setup()
    pcm('silence')
    session.stop()
    await flush()
    connections[0].setup()
    await vi.advanceTimersByTimeAsync(599)
    expect(terminals(events)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(events.at(-1)).toEqual({ type: 'stop', fullText: '' })
    expect(logged.find((l) => l.message === 'speech stream finished')?.data).toMatchObject({ outcome: 'stop' })
  })

  it('every message after the end re-arms the silence timeout', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.activity('ACTIVITY_START')
    c.interim('still')
    session.stop()
    await vi.advanceTimersByTimeAsync(2500)
    c.interim('still going')
    await vi.advanceTimersByTimeAsync(2999)
    expect(terminals(events)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(events.slice(-2)).toEqual([{ type: 'final', text: 'still going' }, { type: 'stop', fullText: 'still going' }])
  })

  it('a server that keeps talking after the end is cut off at the absolute cap', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.activity('ACTIVITY_START')
    session.stop()
    for (let i = 1; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      c.interim(`word ${i}`)
    }
    expect(terminals(events)).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.slice(-2)).toEqual([{ type: 'final', text: 'word 9' }, { type: 'stop', fullText: 'word 9' }])
    expect(logged.find((l) => l.message === 'speech stream finished')?.data).toMatchObject({ outcome: 'stop-timeout' })
  })

  it('times out 3 s after the end and keeps the unconfirmed interim as the last final', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.final('One.')
    c.activity('ACTIVITY_START')
    c.interim('and two')
    session.stop()
    await vi.advanceTimersByTimeAsync(2999)
    expect(terminals(events)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(events.slice(-2)).toEqual([{ type: 'final', text: 'and two' }, { type: 'stop', fullText: 'One. and two' }])
    expect(c.closed).toBe(true)
    expect(logged.find((l) => l.message === 'speech stream finished')?.data).toMatchObject({ outcome: 'stop-timeout', finals: 2 })
  })

  it('cancel closes the socket and says nothing more', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.interim('hello')
    session.cancel()
    expect(c.closed).toBe(true)
    c.final('hello there')
    c.serverClose(1011, 'gone')
    session.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(events).toEqual([{ type: 'start', backend: 'gemini-live' }, { type: 'partial', text: 'hello' }])
  })

  it('cancel before the key resolves never connects', async () => {
    const { connect, events, session } = setup()
    session.cancel()
    await flush()
    expect(connect).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('is silent after its terminal event', async () => {
    const { connections, events, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    session.stop()
    await vi.advanceTimersByTimeAsync(300)
    const count = events.length
    c.interim('late')
    c.final('late')
    c.serverClose(1011)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(events).toHaveLength(count)
    expect(terminals(events)).toHaveLength(1)
  })

  it('without a usable key: one non-recoverable unavailable error, no connection', async () => {
    const { connect, events } = setup({ resolveKey: async () => ({ ok: false, message: 'Add a Gemini provider.' }) })
    await flush()
    expect(connect).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'error', code: 'unavailable', message: 'Add a Gemini provider.', recoverable: false }])
  })

  it('a connect failure is a non-recoverable "Couldn\'t reach Gemini" error, and the key is not logged', async () => {
    const { events } = setup({ connect: async () => { throw new Error(`getaddrinfo ENOTFOUND for wss://x?key=${KEY}`) } })
    await flush()
    expect(terminals(events)).toEqual([{ type: 'error', code: 'unavailable', message: expect.stringMatching(/^Couldn't reach Gemini/), recoverable: false }])
    expect(JSON.stringify(logged)).not.toContain(KEY)
  })

  it('no setupComplete within the connect timeout is "Couldn\'t reach Gemini"', async () => {
    const { events } = setup()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(terminals(events)).toEqual([{ type: 'error', code: 'unavailable', message: expect.stringMatching(/^Couldn't reach Gemini/), recoverable: false }])
  })

  it('an auth close names the provider whose key was rejected', async () => {
    const { connections, events } = setup()
    await flush()
    connections[0].serverClose(1007, 'API key not valid. Please pass a valid API key.')
    expect(terminals(events)).toEqual([{
      type: 'error', code: 'failed', recoverable: false,
      message: 'Gemini rejected the API key of provider Work Gemini. Check it in Settings › AI Credentials.'
    }])
  })

  it('an unexpected close mid-session ends it with an error, after the finals already sent', async () => {
    const { connections, events } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.final('Kept.')
    c.interim('lost')
    c.serverClose(1011)
    expect(events.slice(-2)).toEqual([
      { type: 'partial', text: 'lost' },
      { type: 'error', code: 'failed', message: 'Gemini stopped transcribing unexpectedly.', recoverable: false }
    ])
    expect(events).toContainEqual({ type: 'final', text: 'Kept.' })
  })

  it('a quota close names the provider whose quota is used up', async () => {
    const { connections, events } = setup()
    await flush()
    connections[0].setup()
    connections[0].serverClose(1011, 'RESOURCE_EXHAUSTED: You exceeded your current quota.')
    expect(terminals(events)).toEqual([{
      type: 'error', code: 'failed', recoverable: false,
      message: "Gemini's quota for provider Work Gemini is used up. Check its plan in Google AI Studio, or choose another Gemini provider."
    }])
  })

  it('another close after setup keeps the generic message and adds the reason, short and without the key', async () => {
    const { connections, events } = setup()
    await flush()
    connections[0].setup()
    connections[0].serverClose(1011, `Internal error near ${KEY} ${'x'.repeat(200)}`)
    const [error] = terminals(events)
    expect(error).toMatchObject({ type: 'error', code: 'failed', message: expect.stringMatching(/^Gemini stopped transcribing unexpectedly \(Internal error near \[key\] x+…\)\.$/) })
    expect(error.type === 'error' && error.message.length).toBeLessThan(170)
    expect(JSON.stringify(events)).not.toContain(KEY)
  })

  it('a close before setup with a reason says what Gemini refused', async () => {
    const { connections, events } = setup()
    await flush()
    connections[0].serverClose(1008, 'models/x is not found for API version v1beta')
    expect(terminals(events)).toEqual([{ type: 'error', code: 'unavailable', message: 'Gemini refused to start transcribing: models/x is not found for API version v1beta', recoverable: false }])
  })

  describe('rotation', () => {
    it('opens a fresh connection at 9.5 minutes; the old one\'s last final comes before any word of the new one', async () => {
      const { connections, events, session, pcm } = setup()
      await flush()
      const [old] = connections
      old.setup()
      old.activity('ACTIVITY_START')
      old.interim('end of the old')
      await vi.advanceTimersByTimeAsync(9.5 * 60_000)
      await flush()
      expect(connections).toHaveLength(2)
      const next = connections[1]
      expect(old.ended).toBe(true)
      // Audio now goes to the new one, queued until it is set up.
      pcm('x')
      expect(old.audio).not.toContain('x')
      next.setup()
      expect(next.audio).toEqual(['x'])
      next.activity('ACTIVITY_START')
      next.interim('new words')
      next.utteranceEnd('New words.')
      expect(events.at(-1)).toEqual({ type: 'partial', text: 'end of the old' })
      old.utteranceEnd('End of the old.')
      await vi.advanceTimersByTimeAsync(300)
      expect(old.closed).toBe(true)
      expect(events.slice(-3)).toEqual([
        { type: 'final', text: 'End of the old.' },
        { type: 'partial', text: 'new words' },
        { type: 'final', text: 'New words.' }
      ])
      session.stop()
      await vi.advanceTimersByTimeAsync(300)
      expect(events.at(-1)).toEqual({ type: 'stop', fullText: 'End of the old. New words.' })
      expect(logged.find((l) => l.message === 'speech stream finished')?.data).toMatchObject({ rotations: 1, outcome: 'stop' })
    })

    it('rotates on goAway, and releases the new one\'s words after 3 s if the old one never finishes', async () => {
      const { connections, events } = setup()
      await flush()
      const [old] = connections
      old.setup()
      old.activity('ACTIVITY_START')
      old.interim('stuck')
      old.callbacks.onmessage({ goAway: { timeLeft: '10s' } })
      await flush()
      const next = connections[1]
      next.setup()
      next.final('Fresh.')
      await vi.advanceTimersByTimeAsync(2999)
      expect(events.at(-1)).toEqual({ type: 'partial', text: 'stuck' })
      await vi.advanceTimersByTimeAsync(1)
      expect(events.slice(-2)).toEqual([{ type: 'final', text: 'stuck' }, { type: 'final', text: 'Fresh.' }])
      expect(old.closed).toBe(true)
    })

    it('a stop during the handover waits for both, in order', async () => {
      const { connections, events, session } = setup()
      await flush()
      const [old] = connections
      old.setup()
      old.activity('ACTIVITY_START')
      old.interim('old')
      old.callbacks.onmessage({ goAway: {} })
      await flush()
      const next = connections[1]
      next.setup()
      next.activity('ACTIVITY_START')
      next.interim('new')
      session.stop()
      next.utteranceEnd('New.')
      expect(terminals(events)).toEqual([])
      old.utteranceEnd('Old.')
      await vi.advanceTimersByTimeAsync(300)
      expect(events.slice(-4)).toEqual([
        { type: 'final', text: 'Old.' },
        { type: 'partial', text: 'new' },
        { type: 'final', text: 'New.' },
        { type: 'stop', fullText: 'Old. New.' }
      ])
    })

    it('a handover that timed out does not mark a later clean stop as timed out', async () => {
      const { connections, events, session } = setup()
      await flush()
      const [old] = connections
      old.setup()
      old.activity('ACTIVITY_START')
      old.interim('stuck')
      old.callbacks.onmessage({ goAway: {} })
      await flush()
      const next = connections[1]
      next.setup()
      await vi.advanceTimersByTimeAsync(3000)
      expect(old.closed).toBe(true)
      next.activity('ACTIVITY_START')
      next.utteranceEnd('Clean.')
      session.stop()
      await vi.advanceTimersByTimeAsync(300)
      expect(events.at(-1)).toEqual({ type: 'stop', fullText: 'stuck Clean.' })
      expect(logged.find((l) => l.message === 'speech stream finished')?.data).toMatchObject({ outcome: 'stop', rotations: 1 })
    })

    it('the old socket closing during the handover keeps what it said', async () => {
      const { connections, events } = setup()
      await flush()
      const [old] = connections
      old.setup()
      old.interim('cut')
      old.callbacks.onmessage({ goAway: {} })
      await flush()
      old.serverClose(1000)
      expect(events.at(-1)).toEqual({ type: 'final', text: 'cut' })
      expect(terminals(events)).toEqual([])
    })
  })

  it('caps a session at the length limit and stops as if asked', async () => {
    const { connections, events, session } = setup({ streamMaxSeconds: 0.0001 })
    await flush()
    const [c] = connections
    c.setup()
    session.push(Buffer.alloc(10))
    expect(c.sent.map((s) => s.audio ? Buffer.from(s.audio.data, 'base64').length : 'end')).toEqual([3, 'end'])
    await vi.advanceTimersByTimeAsync(300)
    expect(events.at(-1)).toEqual({ type: 'stop', fullText: '' })
  })

  it('logs one line per session with counts, never the text or the key', async () => {
    const { connections, session } = setup()
    await flush()
    const [c] = connections
    c.setup()
    c.interim('secret words')
    c.utteranceEnd('Secret words.')
    session.stop()
    await vi.advanceTimersByTimeAsync(300)
    const lines = logged.filter((l) => l.message === 'speech stream finished')
    expect(lines).toHaveLength(1)
    expect(lines[0].data).toMatchObject({ engine: 'gemini', backend: 'gemini-live', chosenBecause: 'always', partials: 1, finals: 1, rotations: 0, outcome: 'stop', characters: 13 })
    expect(lines[0].data).toHaveProperty('firstPartialMs')
    const all = JSON.stringify(logged)
    expect(all).not.toMatch(/secret words/i)
    expect(all).not.toContain(KEY)
  })

  it('refuses the batch path', async () => {
    const { engine } = setup()
    expect(await engine.transcribe({ wav: Buffer.alloc(4) })).toMatchObject({ success: false, code: 'unavailable' })
  })
})
