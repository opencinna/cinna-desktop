/**
 * Voice input: what main tells the composer about speech-to-text, and what a
 * transcription returns. Failures are data (`success: false` with a code), never
 * a throw: an error code thrown across IPC does not reach the renderer.
 */

/** The engines main can run. Only the macOS one exists today. */
export type SpeechEngineId = 'macos'

/**
 * Which recognizer the macOS engine runs: SpeechAnalyzer on macOS 26+ once the
 * language's model is installed, SFSpeechRecognizer otherwise. Diagnostics only.
 */
export type SpeechBackend = 'analyzer' | 'sfspeech'

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

export interface SpeechStatus {
  supported: boolean
  engine: SpeechEngineId | null
  reason?: string
  authorization: SpeechAuthorization
  backend?: SpeechBackend
}

export type TranscribeFailureCode = 'denied' | 'unavailable' | 'no-speech' | 'busy' | 'failed'

export type TranscribeResult =
  | { success: true; text: string }
  | { success: false; code: TranscribeFailureCode; message: string }

export interface TranscribeRequest {
  wav: Uint8Array
  locale?: string
}
