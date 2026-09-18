import { createLocalScheduleScheduler } from './localScheduleScheduler'

/**
 * The minute tick that keeps handovers honest (§3.3).
 *
 * The watcher is for *latency* — a brief that lands while the app is open shows
 * up within a debounce — and this is for *correctness*. `fs.watch` misses
 * events (a directory created on Linux, an unmounted volume, a watcher that
 * died and re-armed a beat late), and the app may simply have been closed while
 * somebody worked in a terminal. Every minute the whole set is reconciled from
 * disk, which is idempotent by construction: the digests mean an unchanged
 * folder writes nothing at all.
 *
 * A second instance of the local-schedule scheduler rather than a second timer:
 * it already re-arms on the wall-clock minute, coalesces overlapping passes,
 * suspends on sleep and refreshes on window focus, and `current()` is what stops
 * a pass writing under a profile the user has since switched away from.
 *
 * The import is dynamic for the reason `localScheduleScheduler`'s is: the
 * service imports half of main, and main's composition root imports this.
 */
export const handoverScheduler = createLocalScheduleScheduler(async (scope, current) => {
  const { handoverService } = await import('./handoverService')
  if (current()) await handoverService.scanAll(scope)
})
