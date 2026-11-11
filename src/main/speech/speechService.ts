import type { SpeechCloudStatus, SpeechRelayStatus, SpeechStatus, SpeechStreamEvent, SpeechStreamOptions, TranscribeResult, VoiceCloudService } from '../../shared/speech'
import { createLogger } from '../logger/logger'
import type { SpeechEngine, SpeechStreamSession } from './speechEngine'
import { createMacosSpeechEngine } from './engines/macosSpeech'
import { createGeminiLiveEngine } from './engines/geminiLive'
import { NO_GEMINI_PROVIDER_MESSAGE, readCloudConfig, type CloudTranscriptionConfig } from './geminiCredentials'
import { coreRelayAccess, coreRelayEngine } from './coreRelayWiring'
import { pickRelayLocale } from './engines/coreRelay'

const logger = createLogger('speech')

const NOT_AVAILABLE = 'Audio input is not available on this computer.'
export const RELAY_NOT_OFFERED_MESSAGE =
  'Transcription through the Cinna server is not available right now. Sign in to a Cinna server that offers it, or choose My Gemini key in Settings › Features › Cloud transcription.'
const RELAY_GONE_MESSAGE = 'Transcription through the Cinna server is no longer available.'
export const NO_CLOUD_SERVICE_MESSAGE =
  'Cloud transcription has no service chosen. Choose Cinna server or My Gemini key in Settings › Features › Cloud transcription.'
const NO_RELAY: SpeechRelayStatus = { available: false }

/**
 * The service the Service select shows: the one set, or for `''` the relay
 * while it is available, else the Gemini key. Display only: a session never
 * runs on Gemini for `''` (see {@link sessionCloudService}).
 */
export function effectiveCloudService(setting: VoiceCloudService, relay: SpeechRelayStatus): 'core' | 'gemini' {
  if (setting === 'core' || setting === 'gemini') return setting
  return relay.available ? 'core' : 'gemini'
}

/**
 * The service a cloud session runs on, or null when none is chosen. No cloud
 * is ever chosen implicitly for a billed key: `''` (a mode turned on before
 * the Service setting existed is migrated to `gemini`; Settings saves the
 * service with the mode) runs on the relay while it is available, never on
 * Gemini.
 */
function sessionCloudService(setting: VoiceCloudService, relay: SpeechRelayStatus): 'core' | 'gemini' | null {
  if (setting === 'core' || setting === 'gemini') return setting
  return relay.available ? 'core' : null
}

/** The system's locale, for a relay session nothing else names one for. */
function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

/**
 * Cloud transcription: the engine, and the settings that decide when it runs
 * (read fresh, never decrypting; the engine resolves its key per session).
 */
export interface CloudSpeech {
  engine: SpeechEngine
  config(): CloudTranscriptionConfig
}

/**
 * The Cinna server's relay: its engine, and whether it is available as last
 * known (never waits on the network; may start a background re-read).
 */
export interface RelaySpeech {
  engine: SpeechEngine
  status(): SpeechRelayStatus
}

/** Which engine one session runs on, and why (for the engine's log line). */
type Choice =
  | { engine: SpeechEngine; chosenBecause?: string; locale?: string }
  | { engine: null; message: string }

/**
 * Voice input's main-side owner. Holds the on-device engines in preference
 * order, probes them once (kicked at startup, never blocking it), and picks
 * the engine per session from the cloud setting: `off` on-device only,
 * `always` the cloud service, `fallback` the cloud service only when no
 * on-device engine is supported (a denied permission is the user's answer, not
 * an outage). The cloud service is the Service setting's (Cinna server relay
 * or the user's Gemini key), never swapped for the other when it is unusable.
 * A session never switches engine: an on-device failure while recording is an
 * error, and when the relay is available that error carries an `offer` the
 * user may accept (a new session with `engine: 'core-relay'`). One recording
 * at a time per engine, a transcription or a live dictation alike: a second
 * request while one runs is answered `busy`, not queued.
 */
export function createSpeechService(engines: SpeechEngine[], cloud?: CloudSpeech, relay?: RelaySpeech): {
  startProbe(): Promise<SpeechStatus>
  status(): Promise<SpeechStatus>
  transcribe(input: { wav: Buffer; locale?: string }): Promise<TranscribeResult>
  openStream(options: SpeechStreamOptions, sink: (event: SpeechStreamEvent) => void): SpeechStreamSession
} {
  type OnDevice = Omit<SpeechStatus, 'available' | 'cloud'>
  /** `locale`: the on-device engine's, which a relay session follows when the renderer names none. */
  type Probed = { status: OnDevice; engine: SpeechEngine | null; locale?: string }
  let probed: Promise<Probed> | null = null
  const busy = new Set<SpeechEngine>()

  async function probeAll(): Promise<Probed> {
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
            engine,
            ...(probe.locale ? { locale: probe.locale } : {})
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

  function ensureProbe(): Promise<Probed> {
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

  /** The relay's last known answer; a failed read is "not available". */
  function relayStatus(): SpeechRelayStatus {
    if (!relay) return NO_RELAY
    try {
      return relay.status()
    } catch (err) {
      logger.warn('could not read the relay availability', { err: err instanceof Error ? err.message : String(err) })
      return NO_RELAY
    }
  }

  function cloudStatusOf(config: CloudTranscriptionConfig, relayNow: SpeechRelayStatus): SpeechCloudStatus {
    const setting = config.service ?? ''
    const service = effectiveCloudService(setting, relayNow)
    const runsOn = sessionCloudService(setting, relayNow)
    const usable = runsOn === 'core' ? relayNow.available : runsOn === 'gemini' ? config.providers.length > 0 : false
    return { mode: config.mode, setting, service, usable, providers: config.providers, relay: relayNow }
  }

  function withCloud(onDevice: OnDevice): SpeechStatus {
    const cloudStatus = cloudStatusOf(cloudConfig(), relayStatus())
    return { ...onDevice, available: onDevice.supported || (cloudStatus.mode !== 'off' && cloudStatus.usable), cloud: cloudStatus }
  }

  async function currentStatus(): Promise<SpeechStatus> {
    return withCloud(await onDeviceStatus())
  }

  /**
   * Decided once per session, when it opens. `engine: 'core-relay'` is the
   * user's answer to an offer: the relay, whatever the mode, while it is
   * available.
   */
  async function choose(options: SpeechStreamOptions = {}): Promise<Choice> {
    if (options.engine === 'core-relay') {
      if (!relay || !relayStatus().available) return { engine: null, message: RELAY_GONE_MESSAGE }
      return { engine: relay.engine, chosenBecause: 'offer accepted after an on-device error', locale: await relayLocale(options) }
    }
    const { status, engine } = await ensureProbe()
    const config = cloudConfig()
    const viaCloud = config.mode === 'always' || (config.mode === 'fallback' && !engine)
    if (!viaCloud) return engine ? { engine } : { engine: null, message: NOT_AVAILABLE }
    const chosenBecause = config.mode === 'always' ? 'always' : `fallback: ${status.reason ?? 'no on-device engine'}`
    const relayNow = relayStatus()
    const runsOn = sessionCloudService(config.service ?? '', relayNow)
    if (runsOn === null) return { engine: null, message: NO_CLOUD_SERVICE_MESSAGE }
    if (runsOn === 'core') {
      if (!relay || !relayNow.available) return { engine: null, message: RELAY_NOT_OFFERED_MESSAGE }
      return { engine: relay.engine, chosenBecause, locale: await relayLocale(options) }
    }
    if (!cloud || !config.chosen) return { engine: null, message: NO_GEMINI_PROVIDER_MESSAGE }
    return { engine: cloud.engine, chosenBecause }
  }

  /** The requested locale, else the on-device engine's, else the system's; normalised, `en-US` at worst. */
  async function relayLocale(options: SpeechStreamOptions): Promise<string> {
    const { locale } = await ensureProbe()
    return pickRelayLocale([options.locale, locale, systemLocale()])
  }

  function isOnDevice(engine: SpeechEngine): boolean {
    return engines.includes(engine)
  }

  /** What a recording revealed: it ran (granted), or the user said no (denied). */
  function noteAuthorization(engine: SpeechEngine, authorization: 'granted' | 'denied' | null): void {
    // Only the on-device engine's permission is tracked; a cloud session says nothing about it.
    if (!authorization || !isOnDevice(engine)) return
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
    const deliver = (incoming: SpeechStreamEvent): void => {
      if (ended || cancelled) return
      const event = withOffer(owner, incoming)
      if (owner && event.type === 'start') noteAuthorization(owner, 'granted')
      if (owner && event.type === 'error' && event.code === 'denied') noteAuthorization(owner, 'denied')
      if (event.type === 'stop' || (event.type === 'error' && !event.recoverable)) {
        ended = true
        release()
      }
      sink(event)
    }

    void choose(options).then((choice) => {
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
        inner = engine.openStream({
          ...options,
          ...(choice.chosenBecause ? { chosenBecause: choice.chosenBecause } : {}),
          ...(choice.locale ? { locale: choice.locale } : {})
        }, deliver)
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

  /**
   * An on-device session that broke (not a refusal, not busy, not silence)
   * while the relay is available: the error offers to continue there. Only
   * an offer — the user's click is the consent, never this.
   */
  function withOffer(owner: SpeechEngine | null, event: SpeechStreamEvent): SpeechStreamEvent {
    if (!owner || !relay || !isOnDevice(owner)) return event
    if (event.type !== 'error' || event.recoverable || (event.code !== 'unavailable' && event.code !== 'failed')) return event
    const relayNow = relayStatus()
    if (!relayNow.available) return event
    return { ...event, offer: { engine: 'core-relay', serverName: relayNow.serverName ?? 'the Cinna server' } }
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

export const speechService = createSpeechService(
  [createMacosSpeechEngine()],
  { engine: createGeminiLiveEngine(), config: readCloudConfig },
  { engine: coreRelayEngine, status: () => coreRelayAccess.status() }
)
