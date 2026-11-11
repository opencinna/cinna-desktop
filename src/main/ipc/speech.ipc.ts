import { ipcMain, type MessagePortMain } from 'electron'
import { userActivation } from '../auth/activation'
import { createLogger } from '../logger/logger'
import { speechService } from '../speech/speechService'
import { coreRelayAccess } from '../speech/coreRelayWiring'
import type { SpeechRelayUsageResult, SpeechStatus, SpeechStreamCommand, SpeechStreamEvent, SpeechStreamOptions, TranscribeRequest, TranscribeResult } from '../../shared/speech'
import { ipcHandle } from './_wrap'

const logger = createLogger('speech-ipc')

/** A minute of 16 kHz 16-bit mono is ~2 MB; this bounds a runaway recording. */
const MAX_WAV_BYTES = 32 * 1024 * 1024
/** One streamed audio chunk: the recorder sends ~100 ms (3.2 KB); 64 KB is 2 s. */
export const MAX_STREAM_CHUNK_BYTES = 64 * 1024

/** The most a continued session replays: the renderer keeps at most this much unconfirmed audio. */
export const MAX_REPLAY_SECONDS = 60

/**
 * The renderer's stream options, kept only where well-formed: a non-empty
 * `locale`; `engine` only as `core-relay` (the user accepted an offer); and
 * `replaySeconds` only beside it, a finite number from 0, at most
 * {@link MAX_REPLAY_SECONDS}. Anything else is dropped, never trusted.
 */
export function parseSpeechStreamOptions(options: unknown): SpeechStreamOptions {
  const raw = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>
  const parsed: SpeechStreamOptions = {}
  if (typeof raw.locale === 'string' && raw.locale) parsed.locale = raw.locale
  if (raw.engine === 'core-relay') {
    parsed.engine = 'core-relay'
    const replay = raw.replaySeconds
    if (typeof replay === 'number' && Number.isFinite(replay) && replay >= 0) parsed.replaySeconds = Math.min(replay, MAX_REPLAY_SECONDS)
  }
  return parsed
}

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
  const session = speechService.openStream(parseSpeechStreamOptions(options), post)
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

  // This month's dictation on the profile's Cinna server, for Settings. Failures are data.
  ipcHandle('speech:relay-usage', async (): Promise<SpeechRelayUsageResult> => {
    if (!userActivation.isActivated()) return { ok: false, message: 'Sign in to a Cinna server to see its dictation minutes.' }
    return coreRelayAccess.usage()
  })

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
