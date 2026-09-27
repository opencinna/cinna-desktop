import { describe, expect, it } from 'vitest'
import { relativeTimeUntil } from './scheduleClock'

const now = Date.UTC(2026, 8, 27, 12)
const minutes = (count: number) => now + count * 60_000

describe('relativeTimeUntil', () => {
  it('names the two largest units, singular and plural', () => {
    expect(relativeTimeUntil(now + 30_000, now)).toBe('in less than a minute')
    expect(relativeTimeUntil(minutes(1), now)).toBe('in 1 minute')
    expect(relativeTimeUntil(minutes(5), now)).toBe('in 5 minutes')
    expect(relativeTimeUntil(minutes(60), now)).toBe('in 1 hour')
    expect(relativeTimeUntil(minutes(8 * 60 + 32), now)).toBe('in 8 hours 32 minutes')
    expect(relativeTimeUntil(minutes(24 * 60), now)).toBe('in 1 day')
    expect(relativeTimeUntil(minutes(3 * 24 * 60 + 4 * 60 + 17), now)).toBe('in 3 days 4 hours')
  })

  it('drops a zero second unit rather than skipping to a smaller one', () => {
    expect(relativeTimeUntil(minutes(3 * 24 * 60 + 5), now)).toBe('in 3 days')
    expect(relativeTimeUntil(minutes(2 * 60) + 59_000, now)).toBe('in 2 hours')
  })

  it('says now for a time that has just arrived and overdue once it is well past', () => {
    expect(relativeTimeUntil(now, now)).toBe('now')
    expect(relativeTimeUntil(now - 30_000, now)).toBe('now')
    expect(relativeTimeUntil(minutes(-5), now)).toBe('overdue')
  })
})
