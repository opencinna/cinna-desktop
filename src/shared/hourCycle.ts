/**
 * The device's 12/24-hour override for times the app shows (note due chips):
 * `h23` forces 24-hour, `h12` forces 12-hour, null follows the locale. On
 * macOS it is the "24-hour time" switch (Language & Region / Date & Time);
 * other platforms report null.
 */
export type HourCycle = 'h12' | 'h23'

/** `value` as an hour cycle, or null when it is not one. */
export function parseHourCycle(value: unknown): HourCycle | null {
  return value === 'h12' || value === 'h23' ? value : null
}
