/**
 * Voice input: what main tells the composer about speech-to-text, and what a
 * transcription returns. Failures are data (`success: false` with a code), never
 * a throw: an error code thrown across IPC does not reach the renderer.
 */

/** The engines main can run: macOS's own recognizer, and Gemini Live on the user's own key. */
export type SpeechEngineId = 'macos' | 'gemini'

/**
 * Which recognizer runs: on macOS, SpeechAnalyzer on macOS 26+ once the
 * language's model is installed, SFSpeechRecognizer otherwise; `gemini-live`
 * is Google's cloud transcription. The renderer shows a cloud mark while a
 * session's backend is `gemini-live`; otherwise diagnostics only.
 */
export type SpeechBackend = 'analyzer' | 'sfspeech' | 'gemini-live'

/**
 * Settings › Features › Cloud transcription (`voiceCloudTranscription`): never
 * (`off`, the default), only when the on-device engine is unsupported
 * (`fallback`; a denied permission is the user's answer, not an outage), or
 * always. Chosen once per dictation, never switched mid-session.
 */
export type VoiceCloudTranscription = 'off' | 'fallback' | 'always'

export const VOICE_CLOUD_TRANSCRIPTION_MODES: readonly VoiceCloudTranscription[] = ['off', 'fallback', 'always']

export function isVoiceCloudTranscription(value: unknown): value is VoiceCloudTranscription {
  return typeof value === 'string' && (VOICE_CLOUD_TRANSCRIPTION_MODES as readonly string[]).includes(value)
}

export type SpeechAuthorization = 'granted' | 'not-determined' | 'denied' | 'restricted' | 'unknown'

/** The outcome of an engine's startup probe. */
export interface SpeechProbe {
  supported: boolean
  /** Why it is not supported, or anything else worth logging. */
  reason?: string
  authorization: SpeechAuthorization
  locale?: string
  backend?: SpeechBackend
}

/** A Gemini provider that can transcribe: enabled, with a key. Never the key itself. */
export interface SpeechCloudProvider {
  id: string
  name: string
}

/** The cloud half of the status, read fresh on every `speech:status` (no key is decrypted). */
export interface SpeechCloudStatus {
  mode: VoiceCloudTranscription
  /** At least one usable Gemini provider exists. */
  usable: boolean
  /** The usable Gemini providers, for the settings picker. */
  providers: SpeechCloudProvider[]
}

export interface SpeechStatus {
  /** The on-device engine (probed once at startup). */
  supported: boolean
  engine: SpeechEngineId | null
  reason?: string
  authorization: SpeechAuthorization
  backend?: SpeechBackend
  /**
   * Voice input can run at all: the on-device engine is supported, or cloud
   * transcription is on with a usable key. Gates the mic button and the
   * "Show audio input" row.
   */
  available: boolean
  cloud: SpeechCloudStatus
}

export type TranscribeFailureCode = 'denied' | 'unavailable' | 'no-speech' | 'busy' | 'failed'

export type TranscribeResult =
  | { success: true; text: string }
  | { success: false; code: TranscribeFailureCode; message: string }

export interface TranscribeRequest {
  wav: Uint8Array
  locale?: string
}

/*
 * Streaming dictation: the recorder sends 16 kHz mono 16-bit PCM while the
 * user speaks, and the engine answers with partial and final text. The event
 * shape follows the cross-platform contract (plans/realtime-voice-input):
 * `partial` always carries the whole current unconfirmed segment and replaces
 * the previous one; `final` text is confirmed and never revised.
 */

/** Main → renderer, on the stream's port. */
export type SpeechStreamEvent =
  | { type: 'start'; backend: SpeechBackend }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'engine-change'; backend: SpeechBackend; reason: string }
  /** Recoverable errors are informational; a non-recoverable one ends the session. */
  | { type: 'error'; code: TranscribeFailureCode; message: string; recoverable: boolean }
  /** The session ended normally; `fullText` is every final joined. Nothing follows it. */
  | { type: 'stop'; fullText: string }

/** Renderer → main, on the stream's port. */
export type SpeechStreamCommand =
  /** Raw 16-bit little-endian PCM, 16 kHz, mono. */
  | { type: 'audio'; pcm: Uint8Array }
  /** No more audio: finalize the pending text, then answer `stop`. */
  | { type: 'stop' }
  /** Discard: the engine is killed and nothing more is sent. */
  | { type: 'cancel' }

export interface SpeechStreamOptions {
  locale?: string
}

export const SPEECH_STREAM_SAMPLE_RATE = 16_000

const BACKEND_IDS: readonly string[] = ['analyzer', 'sfspeech', 'gemini-live']
const FAILURE_IDS: readonly string[] = ['denied', 'unavailable', 'no-speech', 'busy', 'failed']

/** Trust-boundary guard for frames arriving on a stream port. */
export function isSpeechStreamEvent(value: unknown): value is SpeechStreamEvent {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  switch (e.type) {
    case 'start': return BACKEND_IDS.includes(e.backend as string)
    case 'partial':
    case 'final': return typeof e.text === 'string'
    case 'engine-change': return BACKEND_IDS.includes(e.backend as string) && typeof e.reason === 'string'
    case 'error': return FAILURE_IDS.includes(e.code as string) && typeof e.message === 'string' && typeof e.recoverable === 'boolean'
    case 'stop': return typeof e.fullText === 'string'
    default: return false
  }
}

/** What `window.api.speech.stream` returns: the renderer's end of one session. */
export interface SpeechStreamHandle {
  /** Raw 16-bit little-endian PCM, 16 kHz, mono. Ignored after stop or cancel. */
  push(pcm: Uint8Array): void
  stop(): void
  cancel(): void
}
