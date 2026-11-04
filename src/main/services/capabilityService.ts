/**
 * The optional capabilities (Notes, Dashboards) as main reads them — see
 * `shared/capabilities.ts`.
 *
 * ## Decided once, across every profile
 *
 * A capability nobody has decided (`'unset'`) is decided by
 * {@link CapabilityService.resolveUnset}: on when any profile already holds a
 * record there (a note not in the trash, a dashboard), off otherwise, and
 * written down so it is never asked again. A decided value — the user's, or
 * this check's — is never touched. A count that throws decides nothing: the
 * key stays `'unset'` (read as off) and the next call tries again.
 *
 * It runs at core startup, once the database is open, and again before every
 * read that could still see `'unset'` (`settings:get-all`, {@link isOn}), so a
 * failure at boot is retried by the next reader rather than by a restart.
 *
 * Core module: no Electron. Writes through the repo, not the IPC-facing
 * `appSettingsService.set`, which refuses `'unset'` and is the user's path.
 */

import { appSettingsRepo } from '../db/appSettings'
import { capabilityCountsRepo } from '../db/capabilityCounts'
import { createLogger } from '../logger/logger'
import { publishEvent } from '../host/events'
import { APP_SETTINGS_CHANGED_CHANNEL } from '../../shared/appSettings'
import { CAPABILITY_SETTING_KEYS, isCapabilityState, type Capability, type CapabilityState } from '../../shared/capabilities'

const logger = createLogger('capabilities')

export interface CapabilityServiceDeps {
  read: (key: (typeof CAPABILITY_SETTING_KEYS)[Capability]) => CapabilityState
  write: (key: (typeof CAPABILITY_SETTING_KEYS)[Capability], value: CapabilityState) => void
  counts: Record<Capability, () => number>
}

export function createCapabilityService(deps: CapabilityServiceDeps) {
  function decide(capability: Capability): CapabilityState {
    const key = CAPABILITY_SETTING_KEYS[capability]
    const current = deps.read(key)
    if (current !== 'unset') return current
    let count: number
    try {
      count = deps.counts[capability]()
    } catch (err) {
      logger.warn('could not count records to decide a capability; it stays off until the next read', {
        capability,
        error: err instanceof Error ? err.message : String(err)
      })
      return 'unset'
    }
    const decided: CapabilityState = count > 0 ? 'on' : 'off'
    deps.write(key, decided)
    logger.info('decided an optional capability from existing records', { capability, decided })
    return decided
  }

  const service = {
    /** Decides every capability still `'unset'`; leaves decided ones alone. Never throws. */
    resolveUnset(): void {
      for (const capability of Object.keys(CAPABILITY_SETTING_KEYS) as Capability[]) {
        try {
          decide(capability)
        } catch (err) {
          // The settings store itself failed: nothing decided, nothing to undo.
          logger.warn('could not decide a capability', { capability, error: err instanceof Error ? err.message : String(err) })
        }
      }
    },

    /** Whether a capability is on, deciding it first if nobody has. Off on any failure. */
    isOn(capability: Capability): boolean {
      try {
        return decide(capability) === 'on'
      } catch {
        return false
      }
    }
  }
  return service
}

export type CapabilityService = ReturnType<typeof createCapabilityService>

export const capabilityService = createCapabilityService({
  // A stored string that is not a state (written by something else) counts as undecided.
  read: (key) => {
    const value = appSettingsRepo.get(key)
    return isCapabilityState(value) ? value : 'unset'
  },
  // Published like a user's write, so a decision made after the renderer's
  // first read (a boot-time count that failed) still reaches its cache.
  write: (key, value) => {
    appSettingsRepo.set(key, value)
    publishEvent(APP_SETTINGS_CHANGED_CHANNEL, { key })
  },
  counts: {
    notes: () => capabilityCountsRepo.notes(),
    dashboards: () => capabilityCountsRepo.dashboards()
  }
})
