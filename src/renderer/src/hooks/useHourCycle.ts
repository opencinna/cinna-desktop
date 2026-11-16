import { useSyncExternalStore } from 'react'
import type { HourCycle } from '../../../shared/hourCycle'

/**
 * The device's 12/24-hour override (macOS "24-hour time"; null elsewhere and
 * when unset), for times the app shows. Read from main when the first
 * component subscribes and again each time the window regains focus — the
 * user may flip the switch in System Settings while the app runs — so every
 * subscribed view re-renders with the new clock.
 */
let current: HourCycle | null = null
const listeners = new Set<() => void>()
let request = 0

function refresh(): void {
  const getHourCycle = window.api?.system?.getHourCycle
  if (!getHourCycle) return
  const mine = ++request
  void getHourCycle()
    .then((next) => {
      // A later read wins; an unchanged value notifies nobody.
      if (mine !== request || next === current) return
      current = next
      for (const listener of listeners) listener()
    })
    .catch(() => {})
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    window.addEventListener('focus', refresh)
    refresh()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('focus', refresh)
  }
}

const snapshot = (): HourCycle | null => current

/**
 * Read the value once before React mounts, so the first note view already
 * paints the device's clock instead of switching from the locale's a moment
 * later (ux_rules rule 1).
 */
export function primeHourCycle(): void {
  refresh()
}

export function useHourCycle(): HourCycle | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Test hook: forget the cached value. */
export function resetHourCycleForTests(): void {
  current = null
  request = 0
}
