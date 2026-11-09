import { useCallback, useEffect, useState } from 'react'

/** How long typing must pause before the results change. */
export const SEARCH_PAUSE_MS = 300

/**
 * The query the results show: `query` once typing has paused for `delay` ms.
 * Results never change under a key still being pressed; `pending` is true
 * while a newer query waits, and `flush` applies it at once (Enter).
 */
export function useSearchPause(query: string, delay = SEARCH_PAUSE_MS): { applied: string; pending: boolean; flush: () => void } {
  const [applied, setApplied] = useState(query)
  useEffect(() => {
    if (query === applied) return
    const timer = setTimeout(() => setApplied(query), delay)
    return () => clearTimeout(timer)
  }, [query, applied, delay])
  const flush = useCallback(() => setApplied(query), [query])
  return { applied, pending: query !== applied, flush }
}
