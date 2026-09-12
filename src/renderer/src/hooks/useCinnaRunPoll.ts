import { useEffect, useMemo, useRef } from 'react'
import type { JobRunData } from '../../../shared/jobs'
import { useRefreshCinnaRun } from './useCinna'

const POLL_INTERVAL_MS = 5_000

function needsLegacyAdoption(run: JobRunData): boolean {
  if (run.refreshMode !== 'legacy_adoption') return false
  return run.status === 'pending' || run.status === 'running'
}

/** Link active legacy run history to Tasks while visible. Bound work is refreshed
 * by the profile task scheduler; this timer stops as soon as adoption succeeds.
 */
export function useCinnaRunPoll(runs: JobRunData[] | undefined): void {
  const refresh = useRefreshCinnaRun()
  // Latest snapshot lives in a ref so the effect doesn't re-establish the
  // interval on every list update — the timer simply reads the freshest ids
  // when it fires.
  const pendingIds = useMemo(
    () => (runs ?? []).filter(needsLegacyAdoption).map((r) => r.id),
    [runs]
  )
  const pendingIdsRef = useRef<string[]>(pendingIds)
  pendingIdsRef.current = pendingIds

  useEffect(() => {
    if (pendingIdsRef.current.length === 0) return

    let intervalId: number | null = null
    const tick = (): void => {
      if (pendingIdsRef.current.length === 0) {
        stop()
        return
      }
      for (const runId of pendingIdsRef.current) {
        refresh.mutate({ runId })
      }
    }
    const start = (): void => {
      if (intervalId !== null) return
      tick() // immediate catch-up on (re)gaining visibility
      intervalId = window.setInterval(tick, POLL_INTERVAL_MS)
    }
    const stop = (): void => {
      if (intervalId !== null) {
        window.clearInterval(intervalId)
        intervalId = null
      }
    }
    const handleVisibility = (): void => {
      if (document.hidden) stop()
      else start()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
    // Re-create the interval when the active set of non-terminal cinna runs
    // changes (anything in `pendingIds`). The ref keeps the latest snapshot
    // available without re-establishing the interval on every list update.
  }, [pendingIds.length])
}
