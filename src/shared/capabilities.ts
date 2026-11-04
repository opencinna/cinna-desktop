/**
 * The optional capabilities a user turns on in Settings → Features →
 * Capabilities: Notes and Dashboards, off for a new user.
 *
 * Each is one installation-global app setting holding an explicit decision.
 * `'unset'` means nobody has decided yet: main decides it once from whether
 * any profile already holds a record there (`capabilityService`), and until it
 * has, every reader treats it as off. `'on'` and `'off'` are decisions — the
 * user's, or that first check's — and are never re-derived.
 */

export type CapabilityState = 'unset' | 'on' | 'off'

export function isCapabilityState(value: unknown): value is CapabilityState {
  return value === 'unset' || value === 'on' || value === 'off'
}

/** The app setting that holds each capability's state. */
export const CAPABILITY_SETTING_KEYS = {
  notes: 'notesCapability',
  dashboards: 'dashboardsCapability'
} as const

export type Capability = keyof typeof CAPABILITY_SETTING_KEYS
