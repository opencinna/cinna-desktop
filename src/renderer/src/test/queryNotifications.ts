import { notifyManager } from '@tanstack/react-query'
import { act } from '@testing-library/react'
import { afterAll } from 'vitest'

/**
 * TanStack Query tells a query's observers about new data on a later timer
 * (`setTimeout(0)`), not at once. A test that waits with one `setTimeout(0)` —
 * or only a microtask flush — of its own races that timer: when the clock
 * ticks between the two being scheduled, as it does under a loaded full
 * `npm test`, the test's fires first and the component has not seen the data
 * yet. The test then fails one run in a few, and a different test each time.
 *
 * Importing this module routes the cache's notifications through the same
 * `setTimeout(0)` as by default, but counted, so `settleQueries()` can wait
 * until none is outstanding instead of guessing a number of ticks.
 */
let pendingNotifies = 0
notifyManager.setScheduler((notify) => {
  pendingNotifies++
  setTimeout(() => {
    pendingNotifies--
    notify()
  }, 0)
})
afterAll(() => {
  notifyManager.setScheduler((notify) => { setTimeout(notify, 0) })
})

/** Wait until the query cache has told every observer what it holds, and the effects that follow have run. */
export async function settleQueries(): Promise<void> {
  await act(async () => {
    while (pendingNotifies > 0) await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {})
}
