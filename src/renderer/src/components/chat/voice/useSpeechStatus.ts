import { useQuery } from '@tanstack/react-query'
import type { SpeechStatus } from '../../../../../shared/speech'

const UNSUPPORTED: SpeechStatus = { supported: false, engine: null, authorization: 'unknown' }

/** A well-formed status, or unsupported: tests and older preloads have no `speech` API. */
function asStatus(value: unknown): SpeechStatus {
  if (!value || typeof value !== 'object' || (value as SpeechStatus).supported !== true) return UNSUPPORTED
  return value as SpeechStatus
}

export const SPEECH_STATUS_QUERY_KEY = ['speech', 'status'] as const

/** Main's startup probe; prefetched at renderer start so nothing appears late. */
export async function fetchSpeechStatus(): Promise<SpeechStatus> {
  const speech = (window.api as { speech?: { status?: () => Promise<unknown> } } | undefined)?.speech
  if (typeof speech?.status !== 'function') return UNSUPPORTED
  return asStatus(await speech.status())
}

/**
 * Whether the composer offers voice input. Main probes once at startup; until
 * authorization reads `granted` main re-reads it, so this refetches on window
 * focus — coming back from System Settings enables the button.
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

/** Denied or restricted: shown, but recording would only fail at transcription. */
export function speechBlocked(status: SpeechStatus): boolean {
  return status.authorization === 'denied' || status.authorization === 'restricted'
}

export const SPEECH_BLOCKED_HINT = 'Allow Cinna in System Settings › Privacy & Security › Speech Recognition'
