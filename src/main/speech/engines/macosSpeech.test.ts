import { describe, expect, it, vi } from 'vitest'
import { createMacosSpeechEngine, parseProbeOutput, parseTranscribeOutput, transcribeTimeoutMs, type HelperRun, type MacosSpeechDeps } from './macosSpeech'

function deps(over: Partial<MacosSpeechDeps> = {}): Partial<MacosSpeechDeps> & { remove: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> } {
  return {
    platform: 'darwin',
    helperPath: () => '/app/resources/speech/cinna-speech',
    exists: () => true,
    writeTemp: async () => '/tmp/cinna-speech-1.wav',
    remove: vi.fn(async () => {}),
    run: vi.fn(async (): Promise<HelperRun> => ({ stdout: '{"ok":true,"text":"hello from cinna"}\n' })),
    ...over
  } as never
}

describe('parseProbeOutput', () => {
  it('reads an available recognizer', () => {
    expect(parseProbeOutput('{"available":true,"onDevice":true,"authorization":"not-determined","locale":"en-GB"}\n'))
      .toEqual({ supported: true, authorization: 'not-determined', locale: 'en-GB' })
  })
  it('skips log noise before the JSON line', () => {
    expect(parseProbeOutput('2026-10-06 cinna-speech No Assistant asset\n{"available":true,"authorization":"granted"}'))
      .toMatchObject({ supported: true, authorization: 'granted' })
  })
  it('is unsupported when unavailable, and keeps denied authorization', () => {
    expect(parseProbeOutput('{"available":false,"authorization":"denied","locale":"xx-XX"}'))
      .toMatchObject({ supported: false, authorization: 'denied', reason: 'Speech recognition is not available for xx-XX' })
  })
  it('passes the backend through and ignores an unknown one', () => {
    expect(parseProbeOutput('{"available":true,"authorization":"granted","backend":"analyzer"}')).toMatchObject({ backend: 'analyzer' })
    expect(parseProbeOutput('{"available":true,"authorization":"granted","backend":"whisper"}')).not.toHaveProperty('backend')
  })
  it('is unsupported on garbage', () => {
    expect(parseProbeOutput('not json')).toMatchObject({ supported: false, authorization: 'unknown' })
    expect(parseProbeOutput('{"available":true,"authorization":"weird"}')).toMatchObject({ authorization: 'unknown' })
  })
})

describe('parseTranscribeOutput', () => {
  it('reads text', () => {
    expect(parseTranscribeOutput('{"ok":true,"text":" Hello from Cinna. "}')).toEqual({ success: true, text: 'Hello from Cinna.' })
  })
  it('maps an empty text to no-speech', () => {
    expect(parseTranscribeOutput('{"ok":true,"text":""}')).toMatchObject({ success: false, code: 'no-speech' })
  })
  it('passes known codes through and folds unknown ones into failed', () => {
    expect(parseTranscribeOutput('{"ok":false,"code":"denied","message":"off"}')).toEqual({ success: false, code: 'denied', message: 'off' })
    expect(parseTranscribeOutput('{"ok":false,"code":"exploded"}')).toEqual({ success: false, code: 'failed', message: 'Transcription failed.' })
    expect(parseTranscribeOutput('')).toMatchObject({ success: false, code: 'failed' })
  })
})

describe('transcribeTimeoutMs', () => {
  it('is a minute plus twice the recording, read from the header byte rate', () => {
    const tenSeconds = Buffer.alloc(44 + 320_000)
    tenSeconds.writeUInt32LE(32_000, 28)
    expect(transcribeTimeoutMs(tenSeconds)).toBe(80_000)
  })
  it('is a minute for anything without a WAV header', () => {
    expect(transcribeTimeoutMs(Buffer.from([1]))).toBe(60_000)
  })
})

describe('createMacosSpeechEngine', () => {
  it('is unsupported off macOS without spawning anything', async () => {
    const d = deps({ platform: 'linux' })
    expect(await createMacosSpeechEngine(d).probe()).toMatchObject({ supported: false, reason: 'Speech recognition needs macOS' })
    expect(d.run).not.toHaveBeenCalled()
  })

  it('is unsupported when the helper is missing', async () => {
    const d = deps({ exists: () => false })
    expect(await createMacosSpeechEngine(d).probe()).toMatchObject({ supported: false, reason: expect.stringContaining('Speech helper not found') })
    expect(await createMacosSpeechEngine(d).transcribe({ wav: Buffer.from([1]) })).toMatchObject({ success: false, code: 'unavailable' })
    expect(d.run).not.toHaveBeenCalled()
  })

  it('probes through the helper', async () => {
    const d = deps({ run: vi.fn(async () => ({ stdout: '{"available":true,"authorization":"granted","locale":"en-US"}' })) })
    expect(await createMacosSpeechEngine(d).probe()).toEqual({ supported: true, authorization: 'granted', locale: 'en-US' })
    expect(d.run).toHaveBeenCalledWith('/app/resources/speech/cinna-speech', ['probe'], 10_000)
  })

  it('transcribes a temp file with a 60 s timeout and deletes it', async () => {
    const d = deps()
    expect(await createMacosSpeechEngine(d).transcribe({ wav: Buffer.from([1]), locale: 'en-US' })).toEqual({ success: true, text: 'hello from cinna' })
    expect(d.run).toHaveBeenCalledWith('/app/resources/speech/cinna-speech', ['transcribe', '--file', '/tmp/cinna-speech-1.wav', '--locale', 'en-US'], 60_000)
    expect(d.remove).toHaveBeenCalledWith('/tmp/cinna-speech-1.wav')
  })

  it('deletes the temp file and reports failed when the helper crashes or times out', async () => {
    const crashed = deps({ run: vi.fn(async () => ({ stdout: '', failure: { message: 'killed', signal: 'SIGABRT' } })) })
    expect(await createMacosSpeechEngine(crashed).transcribe({ wav: Buffer.from([1]) })).toMatchObject({ success: false, code: 'failed', message: expect.stringContaining('usage description') })
    expect(crashed.remove).toHaveBeenCalledWith('/tmp/cinna-speech-1.wav')
    const slow = deps({ run: vi.fn(async () => ({ stdout: '', failure: { message: 'timeout', signal: 'SIGTERM', timedOut: true } })) })
    expect(await createMacosSpeechEngine(slow).transcribe({ wav: Buffer.from([1]) })).toMatchObject({ success: false, code: 'failed', message: 'Transcription took too long.' })
  })

  it('starts one background model install when a transcription asks for it', async () => {
    let finishInstall: () => void = () => {}
    const run = vi.fn(async (_path: string, args: string[]): Promise<HelperRun> => {
      if (args[0] === 'install') return new Promise((resolve) => { finishInstall = () => resolve({ stdout: '{"ok":true}' }) })
      return { stdout: '{"ok":true,"text":"hi","backend":"sfspeech","installModel":true}' }
    })
    const engine = createMacosSpeechEngine(deps({ run }))
    expect(await engine.transcribe({ wav: Buffer.from([1]), locale: 'de-DE' })).toEqual({ success: true, text: 'hi' })
    await engine.transcribe({ wav: Buffer.from([1]), locale: 'de-DE' })
    const installs = run.mock.calls.filter(([, args]) => args[0] === 'install')
    expect(installs).toEqual([['/app/resources/speech/cinna-speech', ['install', '--locale', 'de-DE'], 15 * 60_000]])
    finishInstall()
    await vi.waitFor(async () => {
      await engine.transcribe({ wav: Buffer.from([1]) })
      expect(run.mock.calls.filter(([, args]) => args[0] === 'install')).toHaveLength(2)
    })
  })

  it('does not install a model when the transcription did not ask', async () => {
    const d = deps({ run: vi.fn(async () => ({ stdout: '{"ok":true,"text":"hi","backend":"analyzer"}' })) })
    await createMacosSpeechEngine(d).transcribe({ wav: Buffer.from([1]) })
    expect(d.run).toHaveBeenCalledTimes(1)
  })

  it('deletes the temp file when the run throws', async () => {
    const d = deps({ run: vi.fn(async () => { throw new Error('spawn EACCES') }) })
    await expect(createMacosSpeechEngine(d).transcribe({ wav: Buffer.from([1]) })).rejects.toThrow('spawn EACCES')
    expect(d.remove).toHaveBeenCalledWith('/tmp/cinna-speech-1.wav')
  })
})
