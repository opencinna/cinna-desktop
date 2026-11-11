import { useQuery } from '@tanstack/react-query'
import { isVoiceCloudTranscription, type SpeechCloudProvider, type SpeechCloudStatus, type SpeechStatus } from '../../../../../shared/speech'

const NO_CLOUD: SpeechCloudStatus = { mode: 'off', usable: false, providers: [] }
const UNSUPPORTED: SpeechStatus = { supported: false, engine: null, authorization: 'unknown', available: false, cloud: NO_CLOUD }

function asCloud(value: unknown): SpeechCloudStatus {
  if (!value || typeof value !== 'object') return NO_CLOUD
  const cloud = value as Partial<SpeechCloudStatus>
  const providers = Array.isArray(cloud.providers)
    ? cloud.providers.filter((p): p is SpeechCloudProvider => !!p && typeof p.id === 'string' && typeof p.name === 'string')
    : []
  return { mode: isVoiceCloudTranscription(cloud.mode) ? cloud.mode : 'off', usable: cloud.usable === true && providers.length > 0, providers }
}

/** A well-formed status, or unsupported: tests and older preloads have no `speech` API. */
function asStatus(value: unknown): SpeechStatus {
  if (!value || typeof value !== 'object') return UNSUPPORTED
  const status = value as Partial<SpeechStatus>
  const supported = status.supported === true
  const cloud = asCloud(status.cloud)
  const available = typeof status.available === 'boolean' ? status.available : supported
  if (!supported && !available) return { ...UNSUPPORTED, cloud }
  return { ...(status as SpeechStatus), supported, available, cloud }
}

export const SPEECH_STATUS_QUERY_KEY = ['speech', 'status'] as const

/** Main's startup probe; prefetched at renderer start so nothing appears late. */
export async function fetchSpeechStatus(): Promise<SpeechStatus> {
  const speech = (window.api as { speech?: { status?: () => Promise<unknown> } } | undefined)?.speech
  if (typeof speech?.status !== 'function') return UNSUPPORTED
  return asStatus(await speech.status())
}

/**
 * Whether the composer offers voice input. Main probes the on-device engine
 * once at startup; until authorization reads `granted` main re-reads it, so
 * this refetches on window focus — coming back from System Settings enables
 * the button. The cloud half (setting, usable Gemini providers) is read fresh
 * by main; the query is invalidated when an app setting or a provider changes
 * (`useAppSettings`, `useProviders`).
 */
export function useSpeechStatus(): SpeechStatus {
  const { data } = useQuery({
    queryKey: SPEECH_STATUS_QUERY_KEY,
    queryFn: fetchSpeechStatus,
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
    retry: false
  })
  return data ?? UNSUPPORTED
}

/**
 * Denied or restricted, for a session that would run on the device: shown,
 * but recording would only fail at transcription. With cloud transcription on
 * Always, or on fallback without an on-device engine, the permission does not
 * apply.
 */
export function speechBlocked(status: SpeechStatus): boolean {
  if (status.cloud.mode === 'always' || !status.supported) return false
  return status.authorization === 'denied' || status.authorization === 'restricted'
}

export const SPEECH_BLOCKED_HINT = 'Allow Cinna in System Settings › Privacy & Security › Speech Recognition'
