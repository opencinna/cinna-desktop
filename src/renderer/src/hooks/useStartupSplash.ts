import { useEffect, useState } from 'react'
import { useIsFetching } from '@tanstack/react-query'

/**
 * The launch skeleton. The first time the shell mounts, it carries
 * `data-startup-splash` (main.css, "Startup splash"): its main blocks — the
 * sidebar card and its tabs, the top bar's buttons, the heading and the
 * composer card (`.splash-block`) — show only their surface with a band flowing through
 * it, and everything else is held transparent. Once nothing is loading, it
 * reveals: the content fades in where it already is and the band fades out, so
 * the window never shows the interface arriving piece by piece (ux_rules §1).
 *
 * - `hold`: at least `MIN_HOLD_MS` from the shell's first frame, so the blocks
 *   read as a deliberate step rather than a flicker; at most `MAX_HOLD_MS`, so a
 *   slow server query never keeps the window blank.
 * - Any key or pointer press reveals at once: the user's action wins.
 * - Once per launch. A shell mounted after the login or onboarding screen (or
 *   again after a sign-out) is not a launch, and skips it.
 */
export type StartupSplashPhase = 'hold' | 'reveal' | 'done'

export const MIN_HOLD_MS = 300
export const MAX_HOLD_MS = 1500
/** How long nothing must stay loading: a query that starts when another
 * settles subscribes a render later, and must not be missed in between. */
export const SETTLE_MS = 50
/** Matches the reveal's transitions in main.css. */
export const REVEAL_MS = 280

let used = false

/** The launch went through another screen first; the shell will not get a splash. */
export function skipStartupSplash(): void {
  used = true
}

/** Test seam: makes the next shell mount a launch again. */
export function resetStartupSplashForTests(): void {
  used = false
}

export function useStartupSplash(): StartupSplashPhase {
  const [phase, setPhase] = useState<StartupSplashPhase>(() => (used ? 'done' : 'hold'))
  const [minElapsed, setMinElapsed] = useState(false)
  const fetching = useIsFetching()

  // Marked in an effect, not the initializer: StrictMode renders twice, and the
  // second render must still see a launch.
  useEffect(() => {
    used = true
  }, [])

  useEffect(() => {
    if (phase !== 'hold') return
    const reveal = (): void => setPhase('reveal')
    const min = window.setTimeout(() => setMinElapsed(true), MIN_HOLD_MS)
    const max = window.setTimeout(reveal, MAX_HOLD_MS)
    window.addEventListener('keydown', reveal, true)
    window.addEventListener('pointerdown', reveal, true)
    return () => {
      window.clearTimeout(min)
      window.clearTimeout(max)
      window.removeEventListener('keydown', reveal, true)
      window.removeEventListener('pointerdown', reveal, true)
    }
  }, [phase])

  useEffect(() => {
    if (phase !== 'hold' || !minElapsed || fetching !== 0) return
    // A query starting meanwhile changes `fetching`, and this cleanup cancels the reveal.
    const t = window.setTimeout(() => setPhase('reveal'), SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [phase, minElapsed, fetching])

  useEffect(() => {
    if (phase !== 'reveal') return
    const t = window.setTimeout(() => setPhase('done'), REVEAL_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  return phase
}
