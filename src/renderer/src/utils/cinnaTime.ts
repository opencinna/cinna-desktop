/**
 * Cinna-core serializes `datetime` columns from Python without a timezone
 * suffix (e.g. "2026-05-20T10:00:00.123456" — no trailing Z), but the values
 * are produced via `datetime.utcnow()` so they are UTC. `Date.parse` of a
 * naked ISO string defaults to *local* time, so without a Z the timestamps
 * land off-by-(local UTC offset). Tag naive ISOs as UTC before parsing.
 */
export function parseServerTimestamp(timestamp: string): number {
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(timestamp)
  return Date.parse(hasTz ? timestamp : `${timestamp}Z`)
}

/** Compact "Xm ago / Xh ago / Xd ago" formatter for cinna-server timestamps. */
export function formatRelativeFromServer(
  timestamp: string | null,
  now: Date
): string | null {
  if (!timestamp) return null
  const t = parseServerTimestamp(timestamp)
  if (Number.isNaN(t)) return null
  return formatRelativeFromMillis(now.getTime() - t)
}

/** Same compact format, but from a local `Date` instead of a server string. */
export function formatRelativeFromDate(date: Date, now: Date): string {
  return formatRelativeFromMillis(now.getTime() - date.getTime())
}

function formatRelativeFromMillis(diffMs: number): string {
  const diff = Math.max(0, diffMs)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
