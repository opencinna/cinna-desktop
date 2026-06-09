import { useEffect, useMemo, useRef } from 'react'
import type { JobRunData } from '../../../shared/jobs'
import { useRefreshCinnaRun } from './useCinna'

const POLL_INTERVAL_MS = 5_000

function isNonTerminalCinna(run: JobRunData): boolean {
  if (run.type !== 'cinna_task') return false
  return run.status === 'pending' || run.status === 'running'
}

/**
 * Poll cinna-core for any non-terminal cinna_task runs in `runs`. Polls every 5s
 * **only while the window is visible**, pausing entirely when hidden and firing
 * an immediate catch-up tick on return — the desktop analog of the mobile app's
 * foreground-only polling. Keeping a background tier meant the poll could start a
 * token refresh just as the machine slept, orphaning it (→ rotation-replay
 * self-logout). Stops automatically when no non-terminal runs remain.
 */
export function useCinnaRunPoll(runs: JobRunData[] | undefined): void {
  const refresh = useRefreshCinnaRun()
  // Latest snapshot lives in a ref so the effect doesn't re-establish the
  // interval on every list update — the timer simply reads the freshest ids
  // when it fires.
  const pendingIds = useMemo(
    () => (runs ?? []).filter(isNonTerminalCinna).map((r) => r.id),
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
