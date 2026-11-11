/**
 * Voice input: what main tells the composer about speech-to-text, and what a
 * transcription returns. Failures are data (`success: false` with a code), never
 * a throw: an error code thrown across IPC does not reach the renderer.
 */

/**
 * The engines main can run: macOS's own recognizer, Gemini Live on the user's
 * own key, and the voice transcription relay of the profile's Cinna server.
 */
export type SpeechEngineId = 'macos' | 'gemini' | 'core'

/**
 * Which recognizer runs: on macOS, SpeechAnalyzer on macOS 26+ once the
 * language's model is installed, SFSpeechRecognizer otherwise; `gemini-live`
 * is Google's cloud transcription on the user's key, `core-relay` the Cinna
 * server's relay. The renderer shows a cloud mark while a session's backend is
 * a cloud one (`isCloudBackend`); otherwise diagnostics only.
 */
export type SpeechBackend = 'analyzer' | 'sfspeech' | 'gemini-live' | 'core-relay'

/** Audio leaves the computer: the mic button wears the cloud mark. */
export function isCloudBackend(backend: SpeechBackend | null | undefined): boolean {
  return backend === 'gemini-live' || backend === 'core-relay'
}

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

/**
 * Settings › Features › Cloud transcription › Service (`voiceCloudService`):
 * which cloud the mode above sends audio to; `core` and `gemini` are that
 * service only, never swapped for the other. `''` (the default) means none was
 * chosen yet: Settings saves the service it shows when a mode is turned on,
 * and a mode already on was migrated to `gemini`. A session under `''` with a
 * mode on runs on the relay while it is available and is refused otherwise —
 * never the billed Gemini key implicitly.
 */
export type VoiceCloudService = '' | 'core' | 'gemini'

export const VOICE_CLOUD_SERVICES: readonly VoiceCloudService[] = ['', 'core', 'gemini']

export function isVoiceCloudService(value: unknown): value is VoiceCloudService {
  return typeof value === 'string' && (VOICE_CLOUD_SERVICES as readonly string[]).includes(value)
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

/**
 * The active profile's Cinna server relay, as last known: never waits on the
 * network. `serverName` is the instance's name, else its host.
 */
export interface SpeechRelayStatus {
  available: boolean
  serverName?: string
}

/**
 * The cloud half of the status, read fresh on every `speech:status` (no key is
 * decrypted, no network is waited on).
 */
export interface SpeechCloudStatus {
  mode: VoiceCloudTranscription
  /** The Service setting as saved (`''` = automatic). */
  setting: VoiceCloudService
  /** The service the Service select shows: the setting, or for `''` the relay while available, else the key. */
  service: 'core' | 'gemini'
  /** A cloud session can run: on the relay while available, or on a usable Gemini key chosen explicitly. */
  usable: boolean
  /** The usable Gemini providers, for the settings picker. */
  providers: SpeechCloudProvider[]
  relay: SpeechRelayStatus
}

/** `GET /api/v1/speech/usage` on the profile's server, for Settings. Failures are data. */
export type SpeechRelayUsageResult =
  | { ok: true; enabled: boolean; usedSeconds: number; capSeconds: number | null; periodEnd: string }
  | { ok: false; message: string }

/** Main → every window: the relay's availability changed; refetch `speech:status`. */
export const SPEECH_STATUS_CHANGED_CHANNEL = 'speech:status-changed'

export interface SpeechStatus {
  /** The on-device engine (probed once at startup). */
  supported: boolean
  engine: SpeechEngineId | null
  reason?: string
  authorization: SpeechAuthorization
  backend?: SpeechBackend
  /**
   * Voice input can run at all: the on-device engine is supported, or cloud
   * transcription is on with a usable service (Cinna server, or the user's own Gemini key). Gates the mic button and the
   * "Audio input" switch (rendered always, disabled while this is false).
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
  /**
   * Recoverable errors are informational; a non-recoverable one ends the
   * session. `offer`: an on-device session failed and the Cinna server's relay
   * could continue it, if the user agrees (never taken without their click).
   */
  | { type: 'error'; code: TranscribeFailureCode; message: string; recoverable: boolean; offer?: SpeechStreamOffer }
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

/** What a failed on-device session may continue on. */
export interface SpeechStreamOffer {
  engine: 'core-relay'
  serverName: string
}

export interface SpeechStreamOptions {
  locale?: string
  /**
   * The user accepted an offer: run on the Cinna server's relay whatever the
   * cloud mode says (the request is the consent). Refused when it is not
   * available.
   */
  engine?: 'core-relay'
  /** The first N seconds of audio replay what the failed session had not confirmed. */
  replaySeconds?: number
}

export const SPEECH_STREAM_SAMPLE_RATE = 16_000

const BACKEND_IDS: readonly string[] = ['analyzer', 'sfspeech', 'gemini-live', 'core-relay']
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
    case 'error': return FAILURE_IDS.includes(e.code as string) && typeof e.message === 'string' && typeof e.recoverable === 'boolean' &&
      (e.offer === undefined || isSpeechStreamOffer(e.offer))
    case 'stop': return typeof e.fullText === 'string'
    default: return false
  }
}

function isSpeechStreamOffer(value: unknown): value is SpeechStreamOffer {
  if (!value || typeof value !== 'object') return false
  const offer = value as Record<string, unknown>
  return offer.engine === 'core-relay' && typeof offer.serverName === 'string'
}

/** What `window.api.speech.stream` returns: the renderer's end of one session. */
export interface SpeechStreamHandle {
  /** Raw 16-bit little-endian PCM, 16 kHz, mono. Ignored after stop or cancel. */
  push(pcm: Uint8Array): void
  stop(): void
  cancel(): void
}
