import { describe, expect, it, vi } from 'vitest'
import type { SpeechProbe, TranscribeResult } from '../../shared/speech'
import type { SpeechEngine } from './speechEngine'
import { createSpeechService } from './speechService'

function fakeEngine(probe: SpeechProbe | (() => Promise<SpeechProbe>), transcribe?: SpeechEngine['transcribe']): SpeechEngine & { probe: ReturnType<typeof vi.fn> } {
  return {
    id: 'macos',
    probe: vi.fn(typeof probe === 'function' ? probe : async () => probe),
    transcribe: transcribe ?? (async () => ({ success: true, text: 'hello' }))
  }
}

const wav = Buffer.from([1, 2, 3])

describe('speechService', () => {
  it('probes once and serves the cached answer', async () => {
    const engine = fakeEngine({ supported: true, authorization: 'granted' })
    const service = createSpeechService([engine])
    void service.startProbe()
    expect(await service.status()).toEqual({ supported: true, engine: 'macos', authorization: 'granted' })
    await service.status()
    await service.transcribe({ wav })
    expect(engine.probe).toHaveBeenCalledTimes(1)
  })

  it('passes the probed backend through', async () => {
    const service = createSpeechService([fakeEngine({ supported: true, authorization: 'granted', backend: 'analyzer' })])
    expect(await service.status()).toEqual({ supported: true, engine: 'macos', authorization: 'granted', backend: 'analyzer' })
  })

  it('reports unsupported with the engine reason and refuses to transcribe', async () => {
    const service = createSpeechService([fakeEngine({ supported: false, authorization: 'unknown', reason: 'Speech recognition needs macOS' })])
    expect(await service.status()).toEqual({ supported: false, engine: null, authorization: 'unknown', reason: 'Speech recognition needs macOS' })
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
})
