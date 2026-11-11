import { describe, expect, it, vi } from 'vitest'
import type { SpeechProbe, SpeechStreamEvent, TranscribeResult, VoiceCloudTranscription } from '../../shared/speech'
import type { SpeechEngine, SpeechStreamSession } from './speechEngine'

// The singleton reads the database; these tests inject their own config.
vi.mock('./geminiCredentials', () => ({
  NO_GEMINI_PROVIDER_MESSAGE: 'Add a Gemini provider',
  readCloudConfig: () => ({ mode: 'off', providers: [], chosen: null }),
  resolveGeminiKey: async () => ({ ok: false, message: 'none' })
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createSpeechService } = await import('./speechService')

/** The cloud half every status carries when no cloud engine is wired. */
const NO_CLOUD = { available: false, cloud: { mode: 'off', usable: false, providers: [] } }

function fakeEngine(
  probe: SpeechProbe | (() => Promise<SpeechProbe>),
  transcribe?: SpeechEngine['transcribe'],
  openStream?: SpeechEngine['openStream']
): SpeechEngine & { probe: ReturnType<typeof vi.fn> } {
  return {
    id: 'macos',
    probe: vi.fn(typeof probe === 'function' ? probe : async () => probe),
    transcribe: transcribe ?? (async () => ({ success: true, text: 'hello' })),
    openStream: openStream ?? (() => ({ push() {}, stop() {}, cancel() {} }))
  }
}

/** An engine stream the test drives: what it was given, and its sink. */
function streamDouble(): {
  openStream: SpeechEngine['openStream']
  sessions: { sink: (event: SpeechStreamEvent) => void; session: SpeechStreamSession & { pushed: Buffer[]; stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } }[]
} {
  const sessions: ReturnType<typeof streamDouble>['sessions'] = []
  return {
    sessions,
    openStream: (_options, sink) => {
      const pushed: Buffer[] = []
      const session = { pushed, push: (pcm: Buffer) => { pushed.push(pcm) }, stop: vi.fn(), cancel: vi.fn() }
      sessions.push({ sink, session })
      return session
    }
  }
}

const wav = Buffer.from([1, 2, 3])

describe('speechService', () => {
  it('probes once and serves the cached answer', async () => {
    const engine = fakeEngine({ supported: true, authorization: 'granted' })
    const service = createSpeechService([engine])
    void service.startProbe()
    expect(await service.status()).toEqual({ supported: true, engine: 'macos', authorization: 'granted', ...NO_CLOUD, available: true })
    await service.status()
    await service.transcribe({ wav })
    expect(engine.probe).toHaveBeenCalledTimes(1)
  })

  it('passes the probed backend through', async () => {
    const service = createSpeechService([fakeEngine({ supported: true, authorization: 'granted', backend: 'analyzer' })])
    expect(await service.status()).toEqual({ supported: true, engine: 'macos', authorization: 'granted', backend: 'analyzer', ...NO_CLOUD, available: true })
  })

  it('reports unsupported with the engine reason and refuses to transcribe', async () => {
    const service = createSpeechService([fakeEngine({ supported: false, authorization: 'unknown', reason: 'Speech recognition needs macOS' })])
    expect(await service.status()).toEqual({ supported: false, engine: null, authorization: 'unknown', reason: 'Speech recognition needs macOS', ...NO_CLOUD })
    expect(await service.transcribe({ wav })).toMatchObject({ success: false, code: 'unavailable' })
  })

  it('treats a probe that throws as unsupported', async () => {
    const service = createSpeechService([fakeEngine(async () => { throw new Error('boom') })])
    expect(await service.status()).toMatchObject({ supported: false, reason: 'macos: boom' })
  })

  it('answers busy for a second transcription while one runs, then accepts again', async () => {
    const pending: ((result: TranscribeResult) => void)[] = []
    const engine = fakeEngine({ supported: true, authorization: 'granted' }, () => new Promise((resolve) => { pending.push(resolve) }))
    const service = createSpeechService([engine])
    const first = service.transcribe({ wav })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(await service.transcribe({ wav })).toMatchObject({ success: false, code: 'busy' })
    pending[0]({ success: true, text: 'one' })
    expect(await first).toEqual({ success: true, text: 'one' })
    const third = service.transcribe({ wav })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]({ success: true, text: 'three' })
    expect(await third).toEqual({ success: true, text: 'three' })
  })

  it('turns an engine throw into a failed result', async () => {
    const service = createSpeechService([fakeEngine({ supported: true, authorization: 'granted' }, async () => { throw new Error('spawn failed') })])
    expect(await service.transcribe({ wav })).toEqual({ success: false, code: 'failed', message: 'spawn failed' })
  })

  it('re-reads authorization until granted, and records a granted transcription', async () => {
    const engine = fakeEngine({ supported: true, authorization: 'not-determined' })
    const service = createSpeechService([engine])
    expect((await service.status()).authorization).toBe('not-determined')
    engine.probe.mockResolvedValue({ supported: true, authorization: 'denied' })
    expect((await service.status()).authorization).toBe('denied')
    await service.transcribe({ wav })
    await vi.waitFor(async () => expect((await service.status()).authorization).toBe('granted'))
    const calls = engine.probe.mock.calls.length
    await service.status()
    expect(engine.probe).toHaveBeenCalledTimes(calls)
  })

  describe('openStream', () => {
    const granted: SpeechProbe = { supported: true, authorization: 'granted' }

    it('queues audio and a stop until the engine opens, then passes events through', async () => {
      const double = streamDouble()
      const service = createSpeechService([fakeEngine(granted, undefined, double.openStream)])
      const events: SpeechStreamEvent[] = []
      const session = service.openStream({ locale: 'en-US' }, (e) => events.push(e))
      session.push(Buffer.from([1, 2]))
      session.stop()
      session.push(Buffer.from([3]))
      await vi.waitFor(() => expect(double.sessions).toHaveLength(1))
      const [{ sink, session: inner }] = double.sessions
      expect(inner.pushed).toEqual([Buffer.from([1, 2])])
      expect(inner.stop).toHaveBeenCalledTimes(1)
      sink({ type: 'final', text: 'hi' })
      sink({ type: 'stop', fullText: 'hi' })
      sink({ type: 'partial', text: 'late' })
      expect(events).toEqual([{ type: 'final', text: 'hi' }, { type: 'stop', fullText: 'hi' }])
    })

    it('is unavailable without an engine', async () => {
      const service = createSpeechService([fakeEngine({ supported: false, authorization: 'unknown' })])
      const events: SpeechStreamEvent[] = []
      service.openStream({}, (e) => events.push(e))
      await vi.waitFor(() => expect(events).toEqual([{ type: 'error', code: 'unavailable', message: expect.any(String), recoverable: false }]))
    })

    it('is single-flight with transcribe and with another stream, until the stream ends', async () => {
      const double = streamDouble()
      const pending: ((result: TranscribeResult) => void)[] = []
      const service = createSpeechService([fakeEngine(granted, () => new Promise((resolve) => { pending.push(resolve) }), double.openStream)])

      // A transcription holds the engine: a stream is busy.
      const transcription = service.transcribe({ wav })
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      const refused: SpeechStreamEvent[] = []
      service.openStream({}, (e) => refused.push(e))
      await vi.waitFor(() => expect(refused).toEqual([{ type: 'error', code: 'busy', message: expect.any(String), recoverable: false }]))
      expect(double.sessions).toHaveLength(0)
      pending[0]({ success: true, text: 'one' })
      await transcription

      // A stream holds the engine: a transcription and a second stream are busy.
      service.openStream({}, () => {})
      await vi.waitFor(() => expect(double.sessions).toHaveLength(1))
      expect(await service.transcribe({ wav })).toMatchObject({ success: false, code: 'busy' })
      const second: SpeechStreamEvent[] = []
      service.openStream({}, (e) => second.push(e))
      await vi.waitFor(() => expect(second).toMatchObject([{ type: 'error', code: 'busy' }]))

      // A non-recoverable error ends it and frees the engine.
      double.sessions[0].sink({ type: 'error', code: 'failed', message: 'x', recoverable: false })
      const next = service.transcribe({ wav })
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      pending[1]({ success: true, text: 'two' })
      expect(await next).toEqual({ success: true, text: 'two' })
    })

    it('frees the engine on cancel and sends nothing after it', async () => {
      const double = streamDouble()
      const service = createSpeechService([fakeEngine(granted, undefined, double.openStream)])
      const events: SpeechStreamEvent[] = []
      const session = service.openStream({}, (e) => events.push(e))
      await vi.waitFor(() => expect(double.sessions).toHaveLength(1))
      session.cancel()
      expect(double.sessions[0].session.cancel).toHaveBeenCalledTimes(1)
      double.sessions[0].sink({ type: 'stop', fullText: '' })
      expect(events).toEqual([])
      service.openStream({}, () => {})
      await vi.waitFor(() => expect(double.sessions).toHaveLength(2))
    })

    it('never opens the engine when cancelled before the probe answered', async () => {
      const double = streamDouble()
      const service = createSpeechService([fakeEngine(granted, undefined, double.openStream)])
      service.openStream({}, () => {}).cancel()
      await service.status()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(double.sessions).toHaveLength(0)
    })

    it('records authorization from start and from a denied error', async () => {
      const double = streamDouble()
      const engine = fakeEngine({ supported: true, authorization: 'not-determined' }, undefined, double.openStream)
      const service = createSpeechService([engine])
      service.openStream({}, () => {})
      await vi.waitFor(() => expect(double.sessions).toHaveLength(1))
      // Status re-reads the engine until granted; a failing re-read shows what the stream recorded.
      engine.probe.mockRejectedValue(new Error('offline'))
      double.sessions[0].sink({ type: 'error', code: 'denied', message: 'no', recoverable: false })
      await vi.waitFor(async () => expect((await service.status()).authorization).toBe('denied'))
      engine.probe.mockResolvedValue({ supported: true, authorization: 'not-determined' })
      service.openStream({}, () => {})
      await vi.waitFor(() => expect(double.sessions).toHaveLength(2))
      double.sessions[1].sink({ type: 'start', backend: 'sfspeech' })
      await vi.waitFor(async () => expect((await service.status()).authorization).toBe('granted'))
    })
  })

  describe('engine choice per session', () => {
    type OnDevice = 'supported' | 'unsupported' | 'denied'
    const PROBES: Record<OnDevice, SpeechProbe> = {
      supported: { supported: true, authorization: 'granted' },
      unsupported: { supported: false, authorization: 'unknown', reason: 'Speech recognition needs macOS.' },
      denied: { supported: true, authorization: 'denied' }
    }
    const GEMINI = { id: 'g1', name: 'My Gemini' }

    function setup(mode: VoiceCloudTranscription, onDevice: OnDevice, key: boolean) {
      const local = streamDouble()
      const remote = streamDouble()
      const remoteOptions: unknown[] = []
      const macos = fakeEngine(PROBES[onDevice], undefined, local.openStream)
      const gemini: SpeechEngine = {
        id: 'gemini',
        probe: async () => ({ supported: true, authorization: 'granted' }),
        transcribe: async () => ({ success: false, code: 'unavailable', message: 'live only' }),
        openStream: (options, sink) => { remoteOptions.push(options); return remote.openStream(options, sink) }
      }
      const config = { mode, providers: key ? [GEMINI] : [], chosen: key ? GEMINI : null }
      const service = createSpeechService([macos], { engine: gemini, config: () => config })
      return { service, local, remote, remoteOptions, config }
    }

    async function pick(mode: VoiceCloudTranscription, onDevice: OnDevice, key: boolean): Promise<string> {
      const { service, local, remote } = setup(mode, onDevice, key)
      const events: SpeechStreamEvent[] = []
      service.openStream({}, (e) => events.push(e))
      await vi.waitFor(() => expect(local.sessions.length + remote.sessions.length + events.length).toBe(1))
      if (local.sessions.length) return 'macos'
      if (remote.sessions.length) return 'gemini'
      const [event] = events
      return event.type === 'error' && !event.recoverable ? `${event.code}: ${event.message}` : JSON.stringify(event)
    }

    const NO_ENGINE = 'unavailable: Audio input is not available on this computer.'
    const NO_KEY = 'unavailable: Add a Gemini provider'
    const cases: [VoiceCloudTranscription, OnDevice, boolean, string][] = [
      ['off', 'supported', true, 'macos'],
      ['off', 'supported', false, 'macos'],
      ['off', 'denied', true, 'macos'],
      ['off', 'unsupported', true, NO_ENGINE],
      ['off', 'unsupported', false, NO_ENGINE],
      ['fallback', 'supported', true, 'macos'],
      ['fallback', 'supported', false, 'macos'],
      // Denied is the user's answer, not an outage: the on-device engine reports it.
      ['fallback', 'denied', true, 'macos'],
      ['fallback', 'denied', false, 'macos'],
      ['fallback', 'unsupported', true, 'gemini'],
      ['fallback', 'unsupported', false, NO_KEY],
      ['always', 'supported', true, 'gemini'],
      ['always', 'denied', true, 'gemini'],
      ['always', 'unsupported', true, 'gemini'],
      ['always', 'supported', false, NO_KEY],
      ['always', 'denied', false, NO_KEY],
      ['always', 'unsupported', false, NO_KEY]
    ]
    it.each(cases)('%s, on-device %s, key %s → %s', async (mode, onDevice, key, expected) => {
      expect(await pick(mode, onDevice, key)).toBe(expected)
    })

    it.each([
      ['off', 'supported', true, true],
      ['off', 'unsupported', true, false],
      ['fallback', 'unsupported', true, true],
      ['fallback', 'unsupported', false, false],
      ['always', 'unsupported', true, true],
      ['always', 'unsupported', false, false],
      ['always', 'supported', false, true]
    ] as [VoiceCloudTranscription, OnDevice, boolean, boolean][])('status: %s, on-device %s, key %s → available %s', async (mode, onDevice, key, available) => {
      const { service } = setup(mode, onDevice, key)
      const status = await service.status()
      expect(status.available).toBe(available)
      expect(status.cloud).toEqual({ mode, usable: key, providers: key ? [GEMINI] : [] })
    })

    it('reads the cloud setting fresh on every status and every session', async () => {
      const { service, config, local, remote } = setup('off', 'supported', true)
      expect((await service.status()).cloud.mode).toBe('off')
      config.mode = 'always'
      expect((await service.status()).cloud.mode).toBe('always')
      service.openStream({}, () => {})
      await vi.waitFor(() => expect(remote.sessions).toHaveLength(1))
      expect(local.sessions).toHaveLength(0)
    })

    it('tells the cloud engine why it was chosen', async () => {
      const always = setup('always', 'supported', true)
      always.service.openStream({ locale: 'en-US' }, () => {})
      await vi.waitFor(() => expect(always.remoteOptions).toEqual([{ locale: 'en-US', chosenBecause: 'always' }]))
      const fallback = setup('fallback', 'unsupported', true)
      fallback.service.openStream({}, () => {})
      await vi.waitFor(() => expect(fallback.remoteOptions).toEqual([{ chosenBecause: 'fallback: Speech recognition needs macOS.' }]))
    })

    it('treats a settings read that throws as off', async () => {
      const service = createSpeechService([fakeEngine(PROBES.unsupported)], {
        engine: fakeEngine(PROBES.supported),
        config: () => { throw new Error('db closed') }
      })
      expect(await service.status()).toMatchObject({ available: false, cloud: { mode: 'off', usable: false } })
    })

    it('never records on-device authorization from a cloud session', async () => {
      const { service, remote } = setup('always', 'denied', true)
      service.openStream({}, () => {})
      await vi.waitFor(() => expect(remote.sessions).toHaveLength(1))
      remote.sessions[0].sink({ type: 'start', backend: 'gemini-live' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect((await service.status()).authorization).toBe('denied')
    })

    it('keeps one busy slot per engine: a cloud session does not block the on-device one', async () => {
      const { service, config, local, remote } = setup('always', 'supported', true)
      service.openStream({}, () => {})
      await vi.waitFor(() => expect(remote.sessions).toHaveLength(1))
      const second: SpeechStreamEvent[] = []
      service.openStream({}, (e) => second.push(e))
      await vi.waitFor(() => expect(second).toMatchObject([{ type: 'error', code: 'busy' }]))
      config.mode = 'off'
      service.openStream({}, () => {})
      await vi.waitFor(() => expect(local.sessions).toHaveLength(1))
    })

    it('routes the batch path the same way; the cloud engine refuses it', async () => {
      const { service } = setup('always', 'supported', true)
      expect(await service.transcribe({ wav })).toEqual({ success: false, code: 'unavailable', message: 'live only' })
      const none = setup('always', 'supported', false)
      expect(await none.service.transcribe({ wav })).toEqual({ success: false, code: 'unavailable', message: 'Add a Gemini provider' })
    })
  })
})
