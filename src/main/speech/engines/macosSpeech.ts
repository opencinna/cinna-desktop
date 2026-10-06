import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SpeechAuthorization, SpeechBackend, SpeechProbe, TranscribeFailureCode, TranscribeResult } from '../../../shared/speech'
import { runtimeHost } from '../../host/runtimeHost'
import { createLogger } from '../../logger/logger'
import type { SpeechEngine } from '../speechEngine'

const logger = createLogger('speech-macos')

const HELPER_NAME = 'cinna-speech'
const PROBE_TIMEOUT_MS = 10_000
const TRANSCRIBE_TIMEOUT_MS = 60_000
/** A language model for SpeechAnalyzer is a download of a few hundred MB. */
const INSTALL_TIMEOUT_MS = 15 * 60_000

/** What a helper run produced: its stdout, or why it did not finish. */
export interface HelperRun {
  stdout: string
  /** Set when the process did not exit 0 on its own (timeout, signal, spawn failure, crash). */
  failure?: { message: string; signal?: string | null; timedOut?: boolean }
}

export interface MacosSpeechDeps {
  platform: NodeJS.Platform
  helperPath(): string
  exists(path: string): boolean
  run(path: string, args: string[], timeoutMs: number): Promise<HelperRun>
  writeTemp(bytes: Buffer): Promise<string>
  remove(path: string): Promise<void>
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
    execFile(path, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (!error) return resolve({ stdout: `${stdout}` })
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
      resolve({
        stdout: `${stdout ?? ''}`,
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
  remove: (path) => rm(path, { force: true })
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
  const byteRate = wav.length >= 44 ? wav.readUInt32LE(28) : 0
  if (byteRate <= 0) return TRANSCRIBE_TIMEOUT_MS
  const durationMs = ((wav.length - 44) / byteRate) * 1000
  return TRANSCRIBE_TIMEOUT_MS + Math.ceil(2 * durationMs)
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

/**
 * macOS's own speech recognition, on the device only, through the bundled
 * `cinna-speech` helper: SpeechAnalyzer on macOS 26+ once the language's model
 * is installed, SFSpeechRecognizer otherwise. The helper is spawned per call;
 * the recording goes to a temp WAV that is always deleted. When a
 * transcription reports the macOS 26 model missing, one background `install`
 * run fetches it, and later transcriptions pick SpeechAnalyzer up on their own.
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
        if (run.failure) {
          logger.warn('speech transcription failed', run.failure)
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
        const analyzerError = lastJsonLine(run.stdout)?.analyzerError
        if (typeof analyzerError === 'string') logger.warn('SpeechAnalyzer failed, fell back to SFSpeechRecognizer', { analyzerError })
        return parseTranscribeOutput(run.stdout)
      } finally {
        if (file) await deps.remove(file).catch((err: unknown) => logger.warn('could not delete speech temp file', { err: String(err) }))
      }
    }
  }
}
