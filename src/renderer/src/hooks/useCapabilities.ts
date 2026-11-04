import { useMemo } from 'react'
import { useAppSettings } from './useAppSettings'
import type { CapabilityFlags } from '../stores/ui.store'

/**
 * Whether Notes and Dashboards are on (Settings → Features → Capabilities),
 * from main's installation-global app settings. Main decides a capability
 * nobody has set before the first read can answer (`capabilityService`), so
 * only `'on'` is on: `'unset'`, and the settings not loaded yet, read as off.
 * `loaded` tells "not loaded yet" apart, for a reaction to a capability being
 * off (leaving its tab) that must not fire on a launch before the answer.
 * The two tabs are the last on the rail, so their arrival once the settings
 * load appends to it and moves no other tab.
 */
export function useCapabilities(): CapabilityFlags & { loaded: boolean } {
  const { data, isError } = useAppSettings()
  // A failed read is an answer too: off, so a hidden capability's view is left.
  const loaded = data !== undefined || isError
  const notesEnabled = data?.notesCapability === 'on'
  const dashboardsEnabled = data?.dashboardsCapability === 'on'
  return useMemo(() => ({ notesEnabled, dashboardsEnabled, loaded }), [notesEnabled, dashboardsEnabled, loaded])
}

