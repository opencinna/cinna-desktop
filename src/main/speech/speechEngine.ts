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

/**
 * One speech-to-text backend. Today only macOS's own recognizer; an OpenAI or
 * remote engine implements the same calls. None ever throws for an expected
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
  openStream(options: SpeechStreamOptions, sink: (event: SpeechStreamEvent) => void): SpeechStreamSession
}
