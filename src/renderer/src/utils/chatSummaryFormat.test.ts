import { describe, expect, it } from 'vitest'
import { formatChatDuration, formatChatLasted, formatChatOthers, formatChatStarted } from './chatSummaryFormat'

// Local-time constructors throughout: the formatters work in the user's zone.
const NOW = new Date(2026, 8, 19, 16, 0)

describe('formatChatStarted', () => {
  it('names today and yesterday by calendar day, not by elapsed hours', () => {
    expect(formatChatStarted(new Date(2026, 8, 19, 14, 32), NOW, 'en-GB')).toBe('Today 14:32')
    expect(formatChatStarted(new Date(2026, 8, 18, 23, 50), new Date(2026, 8, 19, 0, 10), 'en-GB')).toBe('Yesterday 23:50')
    expect(formatChatStarted(new Date(2026, 8, 18, 9, 5), NOW, 'en-GB')).toBe('Yesterday 09:05')
  })

  it('shows the date for anything older, and the year only when it differs', () => {
    expect(formatChatStarted(new Date(2026, 8, 12, 14, 32), NOW, 'en-GB')).toMatch(/^12 Sept?, 14:32$/)
    expect(formatChatStarted(new Date(2025, 11, 3, 8, 0), NOW, 'en-GB')).toBe('3 Dec 2025, 08:00')
  })

  it('follows the locale', () => {
    expect(formatChatStarted(new Date(2026, 8, 12, 14, 32), NOW, 'en-US')).toMatch(/^Sep 12, 02:32\sPM$/)
  })
})

describe('formatChatDuration', () => {
  it('steps from minutes to hours to days', () => {
    expect(formatChatDuration(0)).toBe('under a minute')
    expect(formatChatDuration(59_999)).toBe('under a minute')
    expect(formatChatDuration(25 * 60_000)).toBe('25 min')
    expect(formatChatDuration(2 * 3_600_000)).toBe('2 h')
    expect(formatChatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min')
    expect(formatChatDuration(24 * 3_600_000)).toBe('1 day')
    expect(formatChatDuration(3 * 24 * 3_600_000 + 3_600_000)).toBe('3 days')
  })
})

describe('formatChatLasted', () => {
  const first = new Date(2026, 8, 19, 14, 0)
  const last = new Date(2026, 8, 19, 14, 25)

  it('joins the span and the count', () => {
    expect(formatChatLasted(first, last, 14)).toBe('25 min · 14 messages')
  })

  it('drops the row when fewer than two messages give it no span', () => {
    expect(formatChatLasted(first, first, 1)).toBeNull()
    expect(formatChatLasted(null, null, 0)).toBeNull()
  })
})

describe('formatChatOthers', () => {
  it('names up to three and counts the rest', () => {
    expect(formatChatOthers(['Writer', 'Reviewer'])).toBe('Writer, Reviewer')
    expect(formatChatOthers(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C +2')
  })
})
