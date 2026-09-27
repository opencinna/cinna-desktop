import { useEffect, useState } from 'react'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A wall-clock time in the schedule's own zone, falling back to the local one. */
export function scheduleTime(timestamp: number | null | undefined, timezone: string): string {
  if (timestamp == null) return 'Not started'
  try { return new Date(timestamp).toLocaleString(undefined, { timeZone: timezone }) }
  catch { return new Date(timestamp).toLocaleString() }
}

const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`

/**
 * How far away a scheduled time is: "in 8 hours 32 minutes", "in 3 days 4
 * hours". The largest unit and the one below it, the second dropped when it
 * is zero, so a coarse distance never reads as falsely precise. A time that
 * has just arrived is "now"; one more than a minute past is "overdue" (the
 * scheduler admits it when Cinna is next available).
 */
export function relativeTimeUntil(timestamp: number, now: number): string {
  const diff = timestamp - now
  if (diff < -MINUTE) return 'overdue'
  if (diff <= 0) return 'now'
  if (diff < MINUTE) return 'in less than a minute'
  const minutes = Math.floor(diff / MINUTE)
  const days = Math.floor(minutes / (DAY / MINUTE))
  const hours = Math.floor((minutes % (DAY / MINUTE)) / 60)
  const rest = minutes % 60
  if (days > 0) return `in ${unit(days, 'day')}${hours > 0 ? ` ${unit(hours, 'hour')}` : ''}`
  if (hours > 0) return `in ${unit(hours, 'hour')}${rest > 0 ? ` ${unit(rest, 'minute')}` : ''}`
  return `in ${unit(rest, 'minute')}`
}

/** The current time, re-read on an interval so relative times stay current. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
