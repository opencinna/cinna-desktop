import { ipcMain, type MessagePortMain } from 'electron'
import { userActivation } from '../auth/activation'
import { createLogger } from '../logger/logger'
import { speechService } from '../speech/speechService'
import type { SpeechStatus, SpeechStreamCommand, SpeechStreamEvent, TranscribeRequest, TranscribeResult } from '../../shared/speech'
import { ipcHandle } from './_wrap'

const logger = createLogger('speech-ipc')

/** A minute of 16 kHz 16-bit mono is ~2 MB; this bounds a runaway recording. */
const MAX_WAV_BYTES = 32 * 1024 * 1024
/** One streamed audio chunk: the recorder sends ~100 ms (3.2 KB); 64 KB is 2 s. */
export const MAX_STREAM_CHUNK_BYTES = 64 * 1024

/** A frame from the renderer's end of a stream port, or null when it breaks the contract. */
export function parseSpeechStreamCommand(data: unknown): SpeechStreamCommand | null {
  if (!data || typeof data !== 'object') return null
  const command = data as Record<string, unknown>
  switch (command.type) {
    case 'audio':
      if (!(command.pcm instanceof Uint8Array) || command.pcm.byteLength > MAX_STREAM_CHUNK_BYTES) return null
      return { type: 'audio', pcm: command.pcm }
    case 'stop':
      return { type: 'stop' }
    case 'cancel':
      return { type: 'cancel' }
    default:
      return null
  }
}

function isTerminal(event: SpeechStreamEvent): boolean {
  return event.type === 'stop' || (event.type === 'error' && !event.recoverable)
}

/**
 * One live dictation over a MessagePort: the renderer posts `SpeechStreamCommand`s,
 * main posts `SpeechStreamEvent`s back and closes the port after the terminal
 * one. Every failure is an `error` frame, never a throw. The port closing
 * (window gone, renderer reload) cancels the session.
 */
function openSpeechStream(port: MessagePortMain, options: unknown): void {
  port.start()
  let open = true
  const post = (event: SpeechStreamEvent): void => {
    if (!open) return
    port.postMessage(event)
    if (isTerminal(event)) {
      open = false
      port.close()
    }
  }
  if (!userActivation.isActivated()) {
    post({ type: 'error', code: 'failed', message: 'Session not activated — user must authenticate first', recoverable: false })
    return
  }
  const raw = (options ?? {}) as { locale?: unknown }
  const locale = typeof raw.locale === 'string' && raw.locale ? raw.locale : undefined
  const session = speechService.openStream({ locale }, post)
  port.on('message', (message) => {
    if (!open) return
    const command = parseSpeechStreamCommand(message.data)
    if (!command) {
      logger.warn('speech stream: off-contract command, ending the session')
      session.cancel()
      post({ type: 'error', code: 'failed', message: 'Voice input sent audio Cinna could not read.', recoverable: false })
      return
    }
    switch (command.type) {
      case 'audio':
        session.push(Buffer.from(command.pcm.buffer, command.pcm.byteOffset, command.pcm.byteLength))
        return
      case 'stop':
        session.stop()
        return
      case 'cancel':
        session.cancel()
        open = false
        port.close()
        return
    }
  })
  port.on('close', () => {
    if (!open) return
    open = false
    session.cancel()
  })
}

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

  // `ipcRenderer.postMessage` passes the options as the second argument and the
  // port on `event.ports` (see CLAUDE.md).
  ipcMain.on('speech:stream', (event, options: unknown) => {
    const port = event.ports?.[0]
    if (!port) {
      logger.warn('speech:stream arrived with no MessagePort')
      return
    }
    openSpeechStream(port, options)
  })
}
