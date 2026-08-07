import { useAppSettings } from './useAppSettings'

/**
 * Is the hint bar switched on?
 *
 * `showHints` defaults to `true`, but this deliberately checks for an explicit
 * `true` rather than `!== false`: while the settings query is in flight we'd
 * otherwise flash the bar at a user who turned it off.
 *
 * Shared between `HintBar` (renders the bar) and `MainArea` (reserves the
 * bottom space it overlays), so the two can never disagree about whether the
 * strip is there.
 */
export function useHintsEnabled(): boolean {
  const { data: settings } = useAppSettings()
  return settings?.showHints === true
}
