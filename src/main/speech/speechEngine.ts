import type { SpeechEngineId, SpeechProbe, SpeechStreamEvent, SpeechStreamOptions, TranscribeResult } from '../../shared/speech'

/**
 * One live dictation, main's end. `push` takes raw 16-bit little-endian PCM,
 * 16 kHz mono; `stop` ends the audio and lets the engine finalize (the sink
 * then gets `stop`); `cancel` discards everything and the sink hears nothing
 * more. All three are no-ops once the session has ended.
 */
export interface SpeechStreamSession {
  push(pcm: Buffer): void
  stop(): void
  cancel(): void
}

/** What a stream is opened with: the renderer's options, plus why main chose this engine (logged). */
export interface EngineStreamOptions extends SpeechStreamOptions {
  /** `always`, `fallback: <on-device reason>`, or absent for the on-device default. */
  chosenBecause?: string
}

/**
 * One speech-to-text backend: macOS's own recognizer, or Gemini Live on the
 * user's key; another (OpenAI, a cinna-core relay) implements the same calls. None ever throws for an expected
 * failure: `probe` answers `supported: false` with a reason, `transcribe`
 * answers `success: false` with a code, and a stream ends with an `error`
 * event.
 */
export interface SpeechEngine {
  id: SpeechEngineId
  probe(): Promise<SpeechProbe>
  /** `wav`: a 16-bit PCM mono WAV file's bytes. */
  transcribe(input: { wav: Buffer; locale?: string }): Promise<TranscribeResult>
  /**
   * Live dictation. The sink gets `start`, `partial` / `final` text, maybe
   * `engine-change` or a recoverable `error`, and exactly one terminal event:
   * `stop` (with every final joined) or a non-recoverable `error`. Nothing
   * follows the terminal event, and nothing at all follows `cancel`.
   */
  openStream(options: EngineStreamOptions, sink: (event: SpeechStreamEvent) => void): SpeechStreamSession
}
