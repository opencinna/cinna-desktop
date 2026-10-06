import { userActivation } from '../auth/activation'
import { speechService } from '../speech/speechService'
import type { SpeechStatus, TranscribeRequest, TranscribeResult } from '../../shared/speech'
import { ipcHandle } from './_wrap'

/** A minute of 16 kHz 16-bit mono is ~2 MB; this bounds a runaway recording. */
const MAX_WAV_BYTES = 32 * 1024 * 1024

export function registerSpeechHandlers(): void {
  ipcHandle('speech:status', (): Promise<SpeechStatus> => speechService.status())

  // Failures come back as data: a thrown code would not reach the renderer.
  ipcHandle('speech:transcribe', async (_event, data: TranscribeRequest): Promise<TranscribeResult> => {
    userActivation.requireActivated()
    if (!(data?.wav instanceof Uint8Array) || data.wav.byteLength === 0) {
      return { success: false, code: 'failed', message: 'No audio was recorded.' }
    }
    if (data.wav.byteLength > MAX_WAV_BYTES) {
      return { success: false, code: 'failed', message: 'The recording is too long to transcribe.' }
    }
    const locale = typeof data.locale === 'string' && data.locale ? data.locale : undefined
    return speechService.transcribe({ wav: Buffer.from(data.wav.buffer, data.wav.byteOffset, data.wav.byteLength), locale })
  })
}
