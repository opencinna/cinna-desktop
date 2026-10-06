import type { SpeechStatus, TranscribeResult } from '../../shared/speech'
import { createLogger } from '../logger/logger'
import type { SpeechEngine } from './speechEngine'
import { createMacosSpeechEngine } from './engines/macosSpeech'

const logger = createLogger('speech')

/**
 * Voice input's main-side owner. Holds the engines in preference order, probes
 * them once (kicked at startup, never blocking it) and runs transcriptions on
 * the first supported one. One transcription at a time per engine: a second
 * request while one runs is answered `busy`, not queued.
 */
export function createSpeechService(engines: SpeechEngine[]): {
  startProbe(): Promise<SpeechStatus>
  status(): Promise<SpeechStatus>
  transcribe(input: { wav: Buffer; locale?: string }): Promise<TranscribeResult>
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

  function noteAuthorization(transcribed: TranscribeResult): void {
    void ensureProbe().then((result) => {
      if (transcribed.success) result.status = { ...result.status, authorization: 'granted' }
      else if (transcribed.code === 'denied') result.status = { ...result.status, authorization: 'denied' }
    })
  }

  return {
    startProbe: () => ensureProbe().then((result) => result.status),
    status: currentStatus,
    async transcribe(input) {
      const { engine } = await ensureProbe()
      if (!engine) return { success: false, code: 'unavailable', message: 'Audio input is not available on this computer.' }
      if (busy.has(engine)) return { success: false, code: 'busy', message: 'A recording is already being transcribed.' }
      busy.add(engine)
      try {
        const result = await engine.transcribe(input)
        noteAuthorization(result)
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
