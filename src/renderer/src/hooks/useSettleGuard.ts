import { useEffect, useState } from 'react'

/** How long a freshly shown view ignores pointer clicks. */
export const SETTLE_MS = 300

/**
 * `false` for {@link SETTLE_MS} after `key` changes, `true` otherwise.
 *
 * A view change puts new controls under the pointer that caused it, and the
 * second half of a double-click then lands on one of them — "Advanced options"
 * opening a folder picker, a catalog tile starting an install. A control that
 * could be hit that way ignores pointer clicks until its view has settled; see
 * {@link isUnsettledClick}. The key the hook mounts with counts as settled.
 */
export function useSettleGuard(key: unknown, ms: number = SETTLE_MS): boolean {
  // Counts changes rather than comparing values: A → B → A inside the window
  // is still a view that just appeared, and must not read as settled.
  const [seen, setSeen] = useState({ key, changes: 0 })
  const [settledAt, setSettledAt] = useState(0)
  if (!Object.is(seen.key, key)) setSeen({ key, changes: seen.changes + 1 })
  const changes = Object.is(seen.key, key) ? seen.changes : seen.changes + 1
  const settled = settledAt === changes
  useEffect(() => {
    if (settled) return
    const timer = setTimeout(() => setSettledAt(changes), ms)
    return () => clearTimeout(timer)
  }, [changes, settled, ms])
  return settled
}

/**
 * Whether a click should be ignored because its view has not settled. Only a
 * pointer click (`detail > 0`) is: Enter or Space on a focused control is a
 * deliberate choice, not the tail of a double-click.
 */
export function isUnsettledClick(settled: boolean, event: { detail: number }): boolean {
  return !settled && event.detail > 0
}
