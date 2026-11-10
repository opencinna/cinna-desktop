import type { SpeechStatus, SpeechStreamEvent, SpeechStreamOptions, TranscribeResult } from '../../shared/speech'
import { createLogger } from '../logger/logger'
import type { SpeechEngine, SpeechStreamSession } from './speechEngine'
import { createMacosSpeechEngine } from './engines/macosSpeech'

const logger = createLogger('speech')

/**
 * Voice input's main-side owner. Holds the engines in preference order, probes
 * them once (kicked at startup, never blocking it) and runs transcriptions on
 * the first supported one. One recording at a time per engine, a transcription
 * or a live dictation alike: a second request while one runs is answered
 * `busy`, not queued.
 */
export function createSpeechService(engines: SpeechEngine[]): {
  startProbe(): Promise<SpeechStatus>
  status(): Promise<SpeechStatus>
  transcribe(input: { wav: Buffer; locale?: string }): Promise<TranscribeResult>
  openStream(options: SpeechStreamOptions, sink: (event: SpeechStreamEvent) => void): SpeechStreamSession
} {
  let probed: Promise<{ status: SpeechStatus; engine: SpeechEngine | null }> | null = null
  const busy = new Set<SpeechEngine>()

  async function probeAll(): Promise<{ status: SpeechStatus; engine: SpeechEngine | null }> {
    const reasons: string[] = []
    for (const engine of engines) {
      try {
        const probe = await engine.probe()
        if (probe.supported) {
          logger.info('speech engine available', { engine: engine.id, backend: probe.backend, authorization: probe.authorization, locale: probe.locale })
          return {
            status: {
              supported: true,
              engine: engine.id,
              authorization: probe.authorization,
              ...(probe.reason ? { reason: probe.reason } : {}),
              ...(probe.backend ? { backend: probe.backend } : {})
            },
            engine
          }
        }
        reasons.push(probe.reason ?? `${engine.id}: not supported`)
      } catch (err) {
        reasons.push(`${engine.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const reason = reasons.join('; ') || 'No speech engine is configured'
    logger.info('voice input unsupported', { reason })
    return { status: { supported: false, engine: null, authorization: 'unknown', reason }, engine: null }
  }

  function ensureProbe(): Promise<{ status: SpeechStatus; engine: SpeechEngine | null }> {
    probed ??= probeAll()
    return probed
  }

  /**
   * Whether an engine is supported is settled once. Its authorization is not:
   * the user answers the system prompt on the first transcription, or flips the
   * switch in System Settings later. Until it reads `granted`, each status read
   * asks the engine again (single-flight), so returning from System Settings
   * enables the button without a restart.
   */
  let refreshing: Promise<SpeechStatus> | null = null
  async function currentStatus(): Promise<SpeechStatus> {
    const result = await ensureProbe()
    const { status, engine } = result
    if (!engine || status.authorization === 'granted') return status
    refreshing ??= engine.probe()
      .then((probe) => {
        if (probe.supported) result.status = { ...status, authorization: probe.authorization }
        return result.status
      })
      .catch(() => result.status)
      .finally(() => { refreshing = null })
    return refreshing
  }

  /** What a recording revealed: it ran (granted), or the user said no (denied). */
  function noteAuthorization(authorization: 'granted' | 'denied' | null): void {
    if (!authorization) return
    void ensureProbe().then((result) => {
      result.status = { ...result.status, authorization }
    })
  }

  function authorizationOf(transcribed: TranscribeResult): 'granted' | 'denied' | null {
    if (transcribed.success) return 'granted'
    return transcribed.code === 'denied' ? 'denied' : null
  }

  /**
   * The session is returned at once; the engine is picked when the probe has
   * answered (it normally has), and audio pushed before that is queued.
   */
  function openStream(options: SpeechStreamOptions, sink: (event: SpeechStreamEvent) => void): SpeechStreamSession {
    let inner: SpeechStreamSession | null = null
    let owner: SpeechEngine | null = null
    let ended = false
    let cancelled = false
    let stopped = false
    const queued: Buffer[] = []

    const release = (): void => {
      if (owner) busy.delete(owner)
      owner = null
    }
    const deliver = (event: SpeechStreamEvent): void => {
      if (ended || cancelled) return
      if (event.type === 'start') noteAuthorization('granted')
      if (event.type === 'error' && event.code === 'denied') noteAuthorization('denied')
      if (event.type === 'stop' || (event.type === 'error' && !event.recoverable)) {
        ended = true
        release()
      }
      sink(event)
    }

    void ensureProbe().then(({ engine }) => {
      if (cancelled) return
      if (!engine) {
        deliver({ type: 'error', code: 'unavailable', message: 'Audio input is not available on this computer.', recoverable: false })
        return
      }
      if (busy.has(engine)) {
        deliver({ type: 'error', code: 'busy', message: 'A recording is already being transcribed.', recoverable: false })
        return
      }
      busy.add(engine)
      owner = engine
      try {
        inner = engine.openStream(options, deliver)
      } catch (err) {
        logger.error('speech stream failed to open', err)
        deliver({ type: 'error', code: 'failed', message: err instanceof Error ? err.message : String(err), recoverable: false })
        return
      }
      for (const pcm of queued.splice(0)) inner.push(pcm)
      if (stopped) inner.stop()
    })

    return {
      push(pcm) {
        if (ended || cancelled || stopped) return
        if (inner) inner.push(pcm)
        else queued.push(pcm)
      },
      stop() {
        if (ended || cancelled || stopped) return
        stopped = true
        inner?.stop()
      },
      cancel() {
        if (ended || cancelled) return
        cancelled = true
        queued.length = 0
        inner?.cancel()
        release()
      }
    }
  }

  return {
    startProbe: () => ensureProbe().then((result) => result.status),
    status: currentStatus,
    openStream,
    async transcribe(input) {
      const { engine } = await ensureProbe()
      if (!engine) return { success: false, code: 'unavailable', message: 'Audio input is not available on this computer.' }
      if (busy.has(engine)) return { success: false, code: 'busy', message: 'A recording is already being transcribed.' }
      busy.add(engine)
      try {
        const result = await engine.transcribe(input)
        noteAuthorization(authorizationOf(result))
        return result
      } catch (err) {
        logger.error('transcription failed', err)
        return { success: false, code: 'failed', message: err instanceof Error ? err.message : String(err) }
      } finally {
        busy.delete(engine)
      }
    }
  }
}

export const speechService = createSpeechService([createMacosSpeechEngine()])
