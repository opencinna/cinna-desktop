import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SpeechAuthorization, SpeechBackend, SpeechProbe, SpeechStreamEvent, TranscribeFailureCode, TranscribeResult } from '../../../shared/speech'
import { runtimeHost } from '../../host/runtimeHost'
import { createLogger } from '../../logger/logger'
import type { SpeechEngine, SpeechStreamSession } from '../speechEngine'

const logger = createLogger('speech-macos')

const HELPER_NAME = 'cinna-speech'
const PROBE_TIMEOUT_MS = 10_000
const TRANSCRIBE_TIMEOUT_MS = 60_000
/** A language model for SpeechAnalyzer is a download of a few hundred MB. */
const INSTALL_TIMEOUT_MS = 15 * 60_000
/** 16 kHz, 16-bit, mono. */
const STREAM_BYTES_PER_SECOND = 32_000
/** A live dictation stops itself after this much audio. */
const STREAM_MAX_SECONDS = 30 * 60
/** How long the helper gets to print its last finals and `done` after the audio ends. */
const STREAM_STOP_TIMEOUT_MS = 10_000
/** How much of the helper's stderr a stream keeps for its log line. */
const STREAM_STDERR_KEEP = 8 * 1024

/** What a helper run produced: its stdout, or why it did not finish. */
export interface HelperRun {
  stdout: string
  /** What the helper wrote to stderr: its diagnostics and framework noise. */
  stderr?: string
  /** Set when the process did not exit 0 on its own (timeout, signal, spawn failure, crash). */
  failure?: { message: string; signal?: string | null; timedOut?: boolean }
}

/** The slice of a spawned `cinna-speech stream` process a stream session uses. */
export interface StreamChild {
  stdin: {
    write(chunk: Buffer): unknown
    end(): unknown
    on(event: 'error', listener: (err: Error) => void): unknown
  }
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  /** After the process exited and its output streams closed. */
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  /** Spawn failure (ENOENT, EACCES) or a failed kill. */
  on(event: 'error', listener: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface MacosSpeechDeps {
  platform: NodeJS.Platform
  helperPath(): string
  exists(path: string): boolean
  run(path: string, args: string[], timeoutMs: number): Promise<HelperRun>
  writeTemp(bytes: Buffer): Promise<string>
  remove(path: string): Promise<void>
  /** Starts a long-running helper with piped stdio (`cinna-speech stream`). */
  spawn(path: string, args: string[]): StreamChild
  /** Audio a stream accepts before it stops itself, in seconds. */
  streamMaxSeconds: number
  /** How long a stopped stream waits for the helper's `done`. */
  streamStopTimeoutMs: number
}

/**
 * The bundled helper, resolved like the kit contract: packaged builds ship it
 * as an extra resource at `Resources/speech`, development reads the repo's
 * `resources/speech` (built by `scripts/build-speech-helper.sh`).
 */
function bundledHelperPath(): string {
  return runtimeHost.isPackaged
    ? join(runtimeHost.resourcesPath, 'speech', HELPER_NAME)
    : join(runtimeHost.getAppPath(), 'resources', 'speech', HELPER_NAME)
}

function runHelper(path: string, args: string[], timeoutMs: number): Promise<HelperRun> {
  return new Promise((resolve) => {
    execFile(path, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout: `${stdout}`, stderr: `${stderr ?? ''}` })
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
      resolve({
        stdout: `${stdout ?? ''}`,
        stderr: `${stderr ?? ''}`,
        failure: { message: error.message, signal: failure.signal ?? null, timedOut: failure.killed === true && failure.signal === 'SIGTERM' }
      })
    })
  })
}

const defaultDeps: MacosSpeechDeps = {
  platform: process.platform,
  helperPath: bundledHelperPath,
  exists: existsSync,
  run: runHelper,
  async writeTemp(bytes) {
    const path = join(tmpdir(), `cinna-speech-${randomUUID()}.wav`)
    await writeFile(path, bytes)
    return path
  },
  remove: (path) => rm(path, { force: true }),
  spawn: (path, args) => spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  streamMaxSeconds: STREAM_MAX_SECONDS,
  streamStopTimeoutMs: STREAM_STOP_TIMEOUT_MS
}

const AUTHORIZATIONS: readonly SpeechAuthorization[] = ['granted', 'not-determined', 'denied', 'restricted', 'unknown']
const FAILURE_CODES: readonly TranscribeFailureCode[] = ['denied', 'unavailable', 'no-speech', 'busy', 'failed']
const BACKENDS: readonly SpeechBackend[] = ['analyzer', 'sfspeech']

/** The helper prints one JSON object per run, possibly after framework log noise. */
function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // keep looking
    }
  }
  return null
}

/**
 * A transcription's time limit: a minute (which also covers the first run's
 * system prompt), plus twice the recording's length, so a long dictation is
 * not killed halfway. The length comes from the WAV header's byte rate.
 */
export function transcribeTimeoutMs(wav: Buffer): number {
  const seconds = wavSeconds(wav)
  if (seconds === null) return TRANSCRIBE_TIMEOUT_MS
  return TRANSCRIBE_TIMEOUT_MS + Math.ceil(2 * seconds * 1000)
}

/** A WAV's length from its header's byte rate, or null when there is no header to read. */
function wavSeconds(wav: Buffer): number | null {
  const byteRate = wav.length >= 44 ? wav.readUInt32LE(28) : 0
  if (byteRate <= 0) return null
  return Number(((wav.length - 44) / byteRate).toFixed(2))
}

/**
 * The helper's stderr for a log line, or nothing: its own `cinna-speech:`
 * diagnostics always, then the last few lines of framework noise, capped.
 */
function helperStderr(stderr: string | undefined): { stderr?: string } {
  const lines = (stderr ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return {}
  const own = lines.filter((line) => line.startsWith('cinna-speech:'))
  const noise = lines.filter((line) => !line.startsWith('cinna-speech:')).slice(-3)
  return { stderr: [...own, ...noise].join('\n').slice(0, 800) }
}

/** `cinna-speech probe` output → a probe. Malformed output is "not supported". */
export function parseProbeOutput(stdout: string): SpeechProbe {
  const json = lastJsonLine(stdout)
  if (!json) return { supported: false, authorization: 'unknown', reason: 'The speech helper gave no answer' }
  const authorization = AUTHORIZATIONS.includes(json.authorization as SpeechAuthorization)
    ? (json.authorization as SpeechAuthorization)
    : 'unknown'
  const locale = typeof json.locale === 'string' ? json.locale : undefined
  const backend = BACKENDS.includes(json.backend as SpeechBackend) ? { backend: json.backend as SpeechBackend } : {}
  if (json.available !== true) {
    return { supported: false, authorization, locale, ...backend, reason: `Speech recognition is not available${locale ? ` for ${locale}` : ''}` }
  }
  return { supported: true, authorization, locale, ...backend }
}

/**
 * Whether a transcription ran on SFSpeechRecognizer because the macOS 26
 * model for its language is missing, and asks for `install` to fetch it.
 */
export function wantsModelInstall(stdout: string): boolean {
  return lastJsonLine(stdout)?.installModel === true
}

/** `cinna-speech transcribe` output → a result. Malformed output is `failed`. */
export function parseTranscribeOutput(stdout: string): TranscribeResult {
  const json = lastJsonLine(stdout)
  if (!json) return { success: false, code: 'failed', message: 'The speech helper gave no answer.' }
  if (json.ok === true) {
    const text = typeof json.text === 'string' ? json.text.trim() : ''
    return text ? { success: true, text } : { success: false, code: 'no-speech', message: 'No speech was detected.' }
  }
  const code = FAILURE_CODES.includes(json.code as TranscribeFailureCode) ? (json.code as TranscribeFailureCode) : 'failed'
  const message = typeof json.message === 'string' && json.message ? json.message : 'Transcription failed.'
  return { success: false, code, message }
}

/** One line of `cinna-speech stream` output, validated. */
export type HelperStreamLine =
  | { type: 'start'; backend: SpeechBackend; installModel: boolean }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'engine-change'; backend: SpeechBackend; reason: string }
  | { type: 'error'; code: TranscribeFailureCode; message: string; installModel: boolean }
  | { type: 'done' }

/**
 * One stdout line of `cinna-speech stream` → an event, or null for anything
 * else: the frameworks write log noise to stdout, and a line that is not a
 * known event is skipped rather than trusted.
 */
export function parseStreamLine(line: string): HelperStreamLine | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let json: Record<string, unknown>
  try {
    const value = JSON.parse(trimmed) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    json = value as Record<string, unknown>
  } catch {
    return null
  }
  const backend = BACKENDS.includes(json.backend as SpeechBackend) ? (json.backend as SpeechBackend) : null
  switch (json.type) {
    case 'start':
      return backend ? { type: 'start', backend, installModel: json.installModel === true } : null
    case 'partial':
    case 'final':
      return typeof json.text === 'string' ? { type: json.type, text: json.text.trim() } : null
    case 'engine-change':
      return backend ? { type: 'engine-change', backend, reason: typeof json.reason === 'string' ? json.reason : '' } : null
    case 'error': {
      const code = FAILURE_CODES.includes(json.code as TranscribeFailureCode) ? (json.code as TranscribeFailureCode) : 'failed'
      const message = typeof json.message === 'string' && json.message ? json.message : 'Speech recognition failed.'
      return { type: 'error', code, message, installModel: json.installModel === true }
    }
    case 'done':
      return { type: 'done' }
    default:
      return null
  }
}

/** Why a stream session ended, for its log line. */
type StreamOutcome = 'stop' | 'stop-without-done' | 'cancelled' | `error:${TranscribeFailureCode}`

/**
 * macOS's own speech recognition, on the device only, through the bundled
 * `cinna-speech` helper: SpeechAnalyzer on macOS 26+ once the language's model
 * is installed, SFSpeechRecognizer otherwise. The helper is spawned per call;
 * the recording goes to a temp WAV that is always deleted. When a
 * transcription reports the macOS 26 model missing, one background `install`
 * run fetches it, and later transcriptions pick SpeechAnalyzer up on their own.
 * A live dictation (`openStream`) runs one `stream` helper for its length.
 */
export function createMacosSpeechEngine(overrides: Partial<MacosSpeechDeps> = {}): SpeechEngine {
  const deps: MacosSpeechDeps = { ...defaultDeps, ...overrides }
  const localeArgs = (locale?: string): string[] => (locale ? ['--locale', locale] : [])
  let installing: Promise<void> | null = null

  function installModel(helper: string, locale?: string): void {
    if (installing) return
    logger.info('installing the macOS speech model', { locale })
    installing = deps.run(helper, ['install', ...localeArgs(locale)], INSTALL_TIMEOUT_MS)
      .then((run) => {
        if (run.failure) logger.warn('speech model install failed', run.failure)
        else logger.info('speech model install finished', { result: run.stdout.trim() })
      })
      .catch((err: unknown) => logger.warn('speech model install failed', { err: String(err) }))
      .finally(() => { installing = null })
  }

  return {
    id: 'macos',
    async probe() {
      if (deps.platform !== 'darwin') return { supported: false, authorization: 'unknown', reason: 'Speech recognition needs macOS' }
      const helper = deps.helperPath()
      if (!deps.exists(helper)) return { supported: false, authorization: 'unknown', reason: `Speech helper not found at ${helper}` }
      const run = await deps.run(helper, ['probe'], PROBE_TIMEOUT_MS)
      if (run.failure) {
        logger.warn('speech probe failed', run.failure)
        return { supported: false, authorization: 'unknown', reason: `Speech helper failed: ${run.failure.message}` }
      }
      return parseProbeOutput(run.stdout)
    },
    async transcribe({ wav, locale }) {
      if (deps.platform !== 'darwin') return { success: false, code: 'unavailable', message: 'Speech recognition needs macOS.' }
      const helper = deps.helperPath()
      if (!deps.exists(helper)) return { success: false, code: 'unavailable', message: 'The speech helper is missing from this build.' }
      let file: string | null = null
      try {
        file = await deps.writeTemp(wav)
        const run = await deps.run(helper, ['transcribe', '--file', file, ...localeArgs(locale)], transcribeTimeoutMs(wav))
        const stderr = helperStderr(run.stderr)
        if (run.failure) {
          logger.warn('speech transcription failed', { ...run.failure, ...stderr })
          if (run.failure.timedOut) return { success: false, code: 'failed', message: 'Transcription took too long.' }
          // macOS kills a process that touches speech recognition when the app
          // that launched it declares no NSSpeechRecognitionUsageDescription —
          // the case for a development build started from a terminal.
          if (run.failure.signal === 'SIGABRT') {
            return { success: false, code: 'failed', message: 'macOS stopped speech recognition for this app (no usage description).' }
          }
          return { success: false, code: 'failed', message: 'Speech recognition stopped unexpectedly.' }
        }
        if (wantsModelInstall(run.stdout)) installModel(helper, locale)
        const answer = lastJsonLine(run.stdout)
        const analyzerError = answer?.analyzerError
        if (typeof analyzerError === 'string') logger.warn('SpeechAnalyzer failed, fell back to SFSpeechRecognizer', { analyzerError })
        const result = parseTranscribeOutput(run.stdout)
        logger.info('speech transcription finished', {
          backend: answer?.backend ?? 'unknown',
          seconds: wavSeconds(wav),
          locale: locale ?? 'system',
          ...(result.success ? { ok: true, characters: result.text.length } : { ok: false, code: result.code }),
          ...stderr
        })
        return result
      } finally {
        if (file) await deps.remove(file).catch((err: unknown) => logger.warn('could not delete speech temp file', { err: String(err) }))
      }
    },
    openStream({ locale }, sink) {
      return openHelperStream(deps, { locale, sink, installModel })
    }
  }
}

const ENDED_SESSION: SpeechStreamSession = { push() {}, stop() {}, cancel() {} }

/**
 * One `cinna-speech stream` run: PCM in on stdin, NDJSON events out. Main
 * keeps the finals, so `stop` can carry the whole text, and owns the endings
 * the helper cannot report itself: a crash, a helper that never says `done`
 * after the audio ended, and the length cap.
 */
function openHelperStream(
  deps: MacosSpeechDeps,
  { locale, sink, installModel }: {
    locale?: string
    sink: (event: SpeechStreamEvent) => void
    installModel(helper: string, locale?: string): void
  }
): SpeechStreamSession {
  const fail = (message: string, code: TranscribeFailureCode = 'unavailable'): SpeechStreamSession => {
    logger.info('speech stream finished', { backend: 'none', seconds: 0, outcome: `error:${code}` })
    sink({ type: 'error', code, message, recoverable: false })
    return ENDED_SESSION
  }
  if (deps.platform !== 'darwin') return fail('Speech recognition needs macOS.')
  const helper = deps.helperPath()
  if (!deps.exists(helper)) return fail('The speech helper is missing from this build.')

  const opened = Date.now()
  const maxBytes = Math.floor(deps.streamMaxSeconds * STREAM_BYTES_PER_SECOND)
  const finals: string[] = []
  let pending = ''
  let backend: SpeechBackend | 'unknown' = 'unknown'
  let bytes = 0
  let firstPartialMs: number | null = null
  let partials = 0
  let capped = false
  let stopping = false
  /** Set once the sink got its terminal event, or on cancel: the sink hears nothing more. */
  let ended = false
  let exited = false
  let stdoutTail = ''
  let stderr = ''
  let stopTimer: ReturnType<typeof setTimeout> | null = null

  let child: StreamChild
  try {
    child = deps.spawn(helper, ['stream', ...(locale ? ['--locale', locale] : [])])
  } catch (err) {
    logger.warn('speech helper did not start', { err: String(err) })
    return fail('Speech recognition could not start.', 'failed')
  }

  function finish(outcome: StreamOutcome, terminal: SpeechStreamEvent | null): void {
    if (ended) return
    ended = true
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = null
    const fullText = finals.join(' ').trim()
    logger.info('speech stream finished', {
      backend,
      seconds: Number((bytes / STREAM_BYTES_PER_SECOND).toFixed(2)),
      locale: locale ?? 'system',
      firstPartialMs,
      partials,
      finals: finals.length,
      outcome,
      ...(capped ? { capped: true } : {}),
      characters: fullText.length,
      ...helperStderr(stderr)
    })
    if (!exited) {
      // The helper exits on its own after `done` and `error`; anything else is killed.
      if (outcome === 'stop' || outcome.startsWith('error:')) {
        setTimeout(() => { if (!exited) child.kill('SIGTERM') }, 2_000).unref?.()
      } else {
        child.kill('SIGTERM')
      }
    }
    if (terminal) sink(terminal.type === 'stop' ? { type: 'stop', fullText } : terminal)
  }

  /** Ends normally: whatever is still unconfirmed becomes the last final. */
  function settle(outcome: 'stop' | 'stop-without-done'): void {
    if (ended) return
    if (pending) {
      finals.push(pending)
      sink({ type: 'final', text: pending })
      pending = ''
    }
    finish(outcome, { type: 'stop', fullText: '' })
  }

  function failNow(code: TranscribeFailureCode, message: string): void {
    finish(`error:${code}`, { type: 'error', code, message, recoverable: false })
  }

  function onLine(line: string): void {
    if (ended) return
    const event = parseStreamLine(line)
    if (!event) return
    switch (event.type) {
      case 'start':
        backend = event.backend
        if (event.installModel) installModel(helper, locale)
        sink({ type: 'start', backend: event.backend })
        return
      case 'partial':
        pending = event.text
        partials++
        firstPartialMs ??= Date.now() - opened
        sink({ type: 'partial', text: event.text })
        return
      case 'final':
        pending = ''
        if (!event.text) return
        finals.push(event.text)
        sink({ type: 'final', text: event.text })
        return
      case 'engine-change':
        backend = event.backend
        logger.warn('SpeechAnalyzer failed, fell back to SFSpeechRecognizer', { reason: event.reason })
        sink({ type: 'engine-change', backend: event.backend, reason: event.reason })
        return
      case 'error':
        if (event.installModel) installModel(helper, locale)
        failNow(event.code, event.message)
        return
      case 'done':
        settle('stop')
        return
    }
  }

  // One decoder per stream: a multi-byte character split across two reads
  // would otherwise decode as U+FFFD and land in the draft.
  const stdoutText = new StringDecoder('utf8')
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = (stdoutTail + stdoutText.write(chunk)).split('\n')
    stdoutTail = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STREAM_STDERR_KEEP)
  })
  // EPIPE after the helper died: the `close` handler reports it.
  child.stdin.on('error', (err) => logger.debug('speech helper stdin closed', { err: String(err) }))
  child.on('error', (err) => {
    logger.warn('speech helper failed', { err: String(err) })
    failNow('failed', 'Speech recognition could not start.')
  })
  child.on('close', (code, signal) => {
    exited = true
    if (stdoutTail) { onLine(stdoutTail); stdoutTail = '' }
    if (ended) return
    // After the audio ended, a helper that dies without `done` still leaves
    // its finals and the unconfirmed text: keep them.
    if (stopping) { settle('stop-without-done'); return }
    logger.warn('speech helper exited while recording', { code, signal, ...helperStderr(stderr) })
    // See `transcribe`: macOS kills a helper whose responsible app declares no usage description.
    failNow('failed', signal === 'SIGABRT'
      ? 'macOS stopped speech recognition for this app (no usage description).'
      : 'Speech recognition stopped unexpectedly.')
  })

  function stop(): void {
    if (ended || stopping) return
    stopping = true
    child.stdin.end()
    stopTimer = setTimeout(() => {
      stopTimer = null
      logger.warn('speech helper did not finish after the audio ended', { timeoutMs: deps.streamStopTimeoutMs })
      settle('stop-without-done')
    }, deps.streamStopTimeoutMs)
    stopTimer.unref?.()
  }

  return {
    push(pcm) {
      if (ended || stopping || pcm.length === 0) return
      const room = maxBytes - bytes
      const chunk = pcm.length > room ? pcm.subarray(0, room) : pcm
      if (chunk.length > 0) {
        bytes += chunk.length
        child.stdin.write(chunk)
      }
      if (bytes >= maxBytes) {
        capped = true
        stop()
      }
    },
    stop,
    cancel() {
      if (ended) return
      finish('cancelled', null)
    }
  }
}
