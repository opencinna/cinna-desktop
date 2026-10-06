import type { SpeechEngineId, SpeechProbe, TranscribeResult } from '../../shared/speech'

/**
 * One speech-to-text backend. Today only macOS's own recognizer; an OpenAI or
 * remote engine implements the same two calls. Neither ever throws for an
 * expected failure: `probe` answers `supported: false` with a reason and
 * `transcribe` answers `success: false` with a code.
 */
export interface SpeechEngine {
  id: SpeechEngineId
  probe(): Promise<SpeechProbe>
  /** `wav`: a 16-bit PCM mono WAV file's bytes. */
  transcribe(input: { wav: Buffer; locale?: string }): Promise<TranscribeResult>
}
