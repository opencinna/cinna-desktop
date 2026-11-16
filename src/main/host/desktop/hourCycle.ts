import { systemPreferences } from 'electron'
import type { HourCycle } from '../../../shared/hourCycle'

/** What the reader needs from the platform; injected in tests. */
export interface HourCycleDeps {
  platform: NodeJS.Platform
  getUserDefault: (key: string, type: 'boolean') => boolean
}

const systemDeps = (): HourCycleDeps => ({
  platform: process.platform,
  getUserDefault: (key, type) => systemPreferences.getUserDefault(key, type)
})

/**
 * The OS 12/24-hour override. macOS stores the "24-hour time" switch as
 * `AppleICUForce24HourTime` (and the opposite force as
 * `AppleICUForce12HourTime`) in the global domain; Chromium's `Intl` ignores
 * both and follows the locale alone, so en-US with 24-hour on would read
 * "3:00 PM". 24-hour wins if both are somehow set. Windows and Linux: null
 * (the locale decides). Read only; nothing is ever written.
 */
export function readSystemHourCycle(deps: HourCycleDeps = systemDeps()): HourCycle | null {
  if (deps.platform !== 'darwin') return null
  try {
    if (deps.getUserDefault('AppleICUForce24HourTime', 'boolean') === true) return 'h23'
    if (deps.getUserDefault('AppleICUForce12HourTime', 'boolean') === true) return 'h12'
  } catch {
    // An unreadable default is the same as an unset one.
  }
  return null
}

let source: () => HourCycle | null = () => readSystemHourCycle()

/**
 * Replace where the hour cycle comes from. The E2E sandbox installs its own
 * (`CINNA_E2E_HOUR_CYCLE`, else null) so the developer's real setting never
 * decides a test's expected labels.
 */
export function installHourCycleSource(read: () => HourCycle | null): void {
  source = read
}

/** The current override, read fresh on every call (the user may flip it while the app runs). */
export function currentHourCycle(): HourCycle | null {
  return source()
}
