import type { SpeechCloudStatus, SpeechStatus, SpeechStreamEvent, SpeechStreamOptions, TranscribeResult } from '../../shared/speech'
import { createLogger } from '../logger/logger'
import type { SpeechEngine, SpeechStreamSession } from './speechEngine'
import { createMacosSpeechEngine } from './engines/macosSpeech'
import { createGeminiLiveEngine } from './engines/geminiLive'
import { NO_GEMINI_PROVIDER_MESSAGE, readCloudConfig, type CloudTranscriptionConfig } from './geminiCredentials'

const logger = createLogger('speech')

const NOT_AVAILABLE = 'Audio input is not available on this computer.'

/**
 * Cloud transcription: the engine, and the settings that decide when it runs
 * (read fresh, never decrypting; the engine resolves its key per session).
 */
export interface CloudSpeech {
  engine: SpeechEngine
  config(): CloudTranscriptionConfig
}

/** Which engine one session runs on, and why (for the engine's log line). */
type Choice =
  | { engine: SpeechEngine; chosenBecause?: string }
  | { engine: null; message: string }

/**
 * Voice input's main-side owner. Holds the on-device engines in preference
 * order, probes them once (kicked at startup, never blocking it), and picks
 * the engine per session from the cloud setting: `off` on-device only,
 * `always` the cloud engine, `fallback` the cloud engine only when no
 * on-device engine is supported (a denied permission is the user's answer, not
 * an outage). A session never switches engine: an on-device failure while
 * recording is an error, not a silent move to the user's billed key. One
 * recording at a time per engine, a transcription or a live dictation alike:
 * a second request while one runs is answered `busy`, not queued.
 */
export function createSpeechService(engines: SpeechEngine[], cloud?: CloudSpeech): {
  startProbe(): Promise<SpeechStatus>
  status(): Promise<SpeechStatus>
  transcribe(input: { wav: Buffer; locale?: string }): Promise<TranscribeResult>
  openStream(options: SpeechStreamOptions, sink: (event: SpeechStreamEvent) => void): SpeechStreamSession
} {
  type OnDevice = Omit<SpeechStatus, 'available' | 'cloud'>
  let probed: Promise<{ status: OnDevice; engine: SpeechEngine | null }> | null = null
  const busy = new Set<SpeechEngine>()

  async function probeAll(): Promise<{ status: OnDevice; engine: SpeechEngine | null }> {
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

  function ensureProbe(): Promise<{ status: OnDevice; engine: SpeechEngine | null }> {
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
  let refreshing: Promise<OnDevice> | null = null
  async function onDeviceStatus(): Promise<OnDevice> {
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

  /** The cloud setting and its usable providers, read fresh; a failed read is "off". */
  function cloudConfig(): CloudTranscriptionConfig {
    if (!cloud) return { mode: 'off', providers: [], chosen: null }
    try {
      return cloud.config()
    } catch (err) {
      logger.warn('could not read the cloud transcription settings', { err: err instanceof Error ? err.message : String(err) })
      return { mode: 'off', providers: [], chosen: null }
    }
  }

  function withCloud(onDevice: OnDevice): SpeechStatus {
    const config = cloudConfig()
    const cloudStatus: SpeechCloudStatus = { mode: config.mode, usable: config.providers.length > 0, providers: config.providers }
    return { ...onDevice, available: onDevice.supported || (config.mode !== 'off' && cloudStatus.usable), cloud: cloudStatus }
  }

  async function currentStatus(): Promise<SpeechStatus> {
    return withCloud(await onDeviceStatus())
  }

  /** Decided once per session, when it opens. */
  async function choose(): Promise<Choice> {
    const { status, engine } = await ensureProbe()
    const config = cloudConfig()
    const viaCloud = config.mode === 'always' || (config.mode === 'fallback' && !engine)
    if (!viaCloud) return engine ? { engine } : { engine: null, message: NOT_AVAILABLE }
    if (!cloud || !config.chosen) return { engine: null, message: NO_GEMINI_PROVIDER_MESSAGE }
    return {
      engine: cloud.engine,
      chosenBecause: config.mode === 'always' ? 'always' : `fallback: ${status.reason ?? 'no on-device engine'}`
    }
  }

  /** What a recording revealed: it ran (granted), or the user said no (denied). */
  function noteAuthorization(engine: SpeechEngine, authorization: 'granted' | 'denied' | null): void {
    // Only the on-device engine's permission is tracked; a cloud session says nothing about it.
    if (!authorization || engine === cloud?.engine) return
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
      if (owner && event.type === 'start') noteAuthorization(owner, 'granted')
      if (owner && event.type === 'error' && event.code === 'denied') noteAuthorization(owner, 'denied')
      if (event.type === 'stop' || (event.type === 'error' && !event.recoverable)) {
        ended = true
        release()
      }
      sink(event)
    }

    void choose().then((choice) => {
      if (cancelled) return
      if (!choice.engine) {
        deliver({ type: 'error', code: 'unavailable', message: choice.message, recoverable: false })
        return
      }
      const engine = choice.engine
      if (busy.has(engine)) {
        deliver({ type: 'error', code: 'busy', message: 'A recording is already being transcribed.', recoverable: false })
        return
      }
      busy.add(engine)
      owner = engine
      try {
        inner = engine.openStream(choice.chosenBecause ? { ...options, chosenBecause: choice.chosenBecause } : options, deliver)
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
    startProbe: () => ensureProbe().then((result) => withCloud(result.status)),
    status: currentStatus,
    openStream,
    async transcribe(input) {
      const choice = await choose()
      if (!choice.engine) return { success: false, code: 'unavailable', message: choice.message }
      const engine = choice.engine
      if (busy.has(engine)) return { success: false, code: 'busy', message: 'A recording is already being transcribed.' }
      busy.add(engine)
      try {
        const result = await engine.transcribe(input)
        noteAuthorization(engine, authorizationOf(result))
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

export const speechService = createSpeechService([createMacosSpeechEngine()], {
  engine: createGeminiLiveEngine(),
  config: readCloudConfig
})
