import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cachedZoneCount, setClockLocale, dueDayKey, dueOfText, dueTone, findDueTokens, formatDueChip, parseTasks, stripTaskTokens, type TaskDue } from './tasks'

// Chip times follow the device clock; pin a 24-hour locale so labels are stable.
beforeAll(() => setClockLocale('en-GB'))
afterAll(() => setClockLocale(undefined))

// Phase 2d timed due dates (floating vs pinned), the desktop's reading of the
// cross-app contract: one case per grammar row and read rule. Every zone is
// explicit, so nothing depends on the machine running the tests.

const utc = (y: number, mo: number, d: number, h: number, mi: number, s = 0): number => Date.UTC(y, mo - 1, d, h, mi, s)

describe('timed due grammar', () => {
  it('reads a date-only token as all-day', () => {
    expect(dueOfText('x due:2026-11-15')).toEqual({ kind: 'all-day', date: '2026-11-15' })
  })

  it('reads a time without an offset as floating', () => {
    expect(dueOfText('x due:2026-11-15T09:30')).toEqual({ kind: 'floating', date: '2026-11-15', time: '09:30' })
  })

  it('accepts seconds on a floating time and never shows them', () => {
    expect(dueOfText('x due:2026-11-15T09:30:45')).toEqual({ kind: 'floating', date: '2026-11-15', time: '09:30' })
  })

  it.each([
    ['+01:00', utc(2026, 11, 15, 8, 0), 60],
    ['+0100', utc(2026, 11, 15, 8, 0), 60],
    ['Z', utc(2026, 11, 15, 9, 0), 0],
    ['-00:00', utc(2026, 11, 15, 9, 0), 0],
    ['-05:30', utc(2026, 11, 15, 14, 30), -330]
  ])('reads an offset %s as a pinned instant', (offset, instant, offsetMinutes) => {
    expect(dueOfText(`x due:2026-11-15T09:00${offset}`)).toEqual({
      kind: 'pinned',
      date: '2026-11-15',
      time: '09:00',
      instant,
      offsetMinutes,
      zone: null
    })
  })

  it('keeps seconds in a pinned instant', () => {
    expect(dueOfText('x due:2026-11-15T09:00:30Z')).toMatchObject({ kind: 'pinned', instant: utc(2026, 11, 15, 9, 0, 30) })
  })

  it('reads a zoned token whose offset matches the zone', () => {
    expect(dueOfText('x due:2026-11-20T09:00-05:00[America/New_York]')).toEqual({
      kind: 'pinned',
      date: '2026-11-20',
      time: '09:00',
      instant: utc(2026, 11, 20, 14, 0),
      offsetMinutes: -300,
      zone: 'America/New_York'
    })
  })

  it('lets the zone win over a mismatched offset', () => {
    // July in New York is EDT (-04:00), whatever the token's offset says.
    expect(dueOfText('x due:2026-07-01T09:00+00:00[America/New_York]')).toMatchObject({
      kind: 'pinned',
      instant: utc(2026, 7, 1, 13, 0),
      offsetMinutes: -240,
      zone: 'America/New_York'
    })
  })

  it('falls back to the offset for an unknown zone', () => {
    expect(dueOfText('x due:2026-11-15T09:00+01:00[Mars/Olympus_Mons]')).toMatchObject({
      kind: 'pinned',
      instant: utc(2026, 11, 15, 8, 0),
      offsetMinutes: 60,
      zone: null
    })
  })

  it.each(['+25:00', '+01:60'])('reads an unusable offset %s alone as floating', (offset) => {
    expect(dueOfText(`x due:2026-11-15T09:00${offset}`)).toEqual({ kind: 'floating', date: '2026-11-15', time: '09:00' })
  })

  it('reads an unusable offset with an unknown zone as floating', () => {
    expect(dueOfText('x due:2026-11-15T09:00+25:00[Mars/Olympus_Mons]')).toEqual({ kind: 'floating', date: '2026-11-15', time: '09:00' })
  })

  it('uses a valid zone when the offset is unusable', () => {
    expect(dueOfText('x due:2026-11-15T09:00+25:00[Europe/London]')).toMatchObject({
      kind: 'pinned',
      instant: utc(2026, 11, 15, 9, 0),
      offsetMinutes: 0,
      zone: 'Europe/London'
    })
  })

  it.each([
    ['a zone without an offset', 'x due:2026-11-15T09:00[Europe/London]'],
    ['an hours-only offset', 'x due:2026-11-15T09:00+01'],
    ['a one-digit hour', 'x due:2026-11-15T9:00'],
    ['a zone with a space', 'x due:2026-11-15T09:00Z[Europe/ London]']
  ])('does not read %s as a token: the text stays and there is no due', (_name, text) => {
    expect(findDueTokens(text)).toEqual([])
    expect(stripTaskTokens(text)).toBe(text)
  })

  it.each(['T24:00', 'T25:00', 'T09:60', 'T09:00:60', 'T25:00Z', 'T25:00+01:00[Europe/Paris]'])(
    'reads an impossible time %s as all-day on its date, as builds before times did',
    (time) => {
      expect(dueOfText(`x due:2026-11-15${time}`)).toEqual({ kind: 'all-day', date: '2026-11-15' })
    }
  )

  it('still strips an impossible time on a task line, and keeps its date', () => {
    expect(parseTasks('- [ ] call due:2026-11-15T24:00')[0]).toMatchObject({
      text: 'call',
      dueDate: '2026-11-15',
      due: { kind: 'all-day', date: '2026-11-15' }
    })
  })

  it('keeps 📅 date-only: a time after it is text', () => {
    expect(findDueTokens('x 📅 2026-11-15T09:00')).toEqual([])
    expect(stripTaskTokens('x 📅 2026-11-15T09:00')).toBe('x 📅 2026-11-15T09:00')
    const [task] = parseTasks('- [ ] call 📅 2026-11-15 09:00')
    expect(task).toMatchObject({ text: 'call 09:00', dueDate: '2026-11-15', due: { kind: 'all-day', date: '2026-11-15' } })
  })

  it('takes the first valid token when a timed one is present', () => {
    expect(parseTasks('- [ ] a due:2026-11-15T09:00+01:00 b 📅 2026-11-16')[0]).toMatchObject({
      text: 'a b',
      dueDate: '2026-11-15',
      due: { kind: 'pinned', instant: utc(2026, 11, 15, 8, 0) }
    })
    expect(parseTasks('- [ ] a 📅 2026-11-16 b due:2026-11-15T09:00')[0].due).toEqual({ kind: 'all-day', date: '2026-11-16' })
    // An impossible time still counts (all-day on its date), so it is the first match.
    expect(dueOfText('a due:2026-11-15T24:00 b due:2026-11-16T08:00')).toEqual({ kind: 'all-day', date: '2026-11-15' })
  })

  it('returns the token offsets of a zoned token whole', () => {
    const text = 'call due:2026-11-20T09:00-05:00[America/New_York] now'
    const [t] = findDueTokens(text)
    expect(text.slice(t.start, t.end)).toBe('due:2026-11-20T09:00-05:00[America/New_York]')
    expect(stripTaskTokens(text)).toBe('call now')
  })
})

describe('DST for a pinned zoned due', () => {
  it('uses the summer offset after the spring change', () => {
    expect(dueOfText('x due:2026-03-29T09:00+00:00[Europe/London]')).toMatchObject({
      instant: utc(2026, 3, 29, 8, 0),
      offsetMinutes: 60
    })
  })

  it('moves a time in the spring gap forward by the gap', () => {
    // 01:30 does not exist in London on 2026-03-29: it is 02:30 BST, 01:30Z.
    expect(dueOfText('x due:2026-03-29T01:30+00:00[Europe/London]')).toMatchObject({
      instant: utc(2026, 3, 29, 1, 30),
      offsetMinutes: 60
    })
  })

  it('lets a written offset valid in the autumn overlap pick the occurrence', () => {
    // 01:30 happens twice in London on 2026-10-25: in BST (00:30Z), then in GMT (01:30Z).
    expect(dueOfText('x due:2026-10-25T01:30+00:00[Europe/London]')).toMatchObject({
      instant: utc(2026, 10, 25, 1, 30),
      offsetMinutes: 0
    })
    expect(dueOfText('x due:2026-10-25T01:30+01:00[Europe/London]')).toMatchObject({
      instant: utc(2026, 10, 25, 0, 30),
      offsetMinutes: 60
    })
    // The contract's example: the second 01:30 in New York.
    expect(dueOfText('x due:2026-11-01T01:30-05:00[America/New_York]')).toMatchObject({ instant: 1793514600000, offsetMinutes: -300 })
  })

  it('takes the earlier instant in the autumn overlap when the offset matches neither', () => {
    expect(dueOfText('x due:2026-10-25T01:30+05:00[Europe/London]')).toMatchObject({
      instant: utc(2026, 10, 25, 0, 30),
      offsetMinutes: 60
    })
  })
})

describe('day bucket', () => {
  const pinned = dueOfText('x due:2026-11-15T20:00Z')!

  it('puts a pinned instant on its day in the device zone', () => {
    expect(dueDayKey(pinned, 'Pacific/Auckland')).toBe('2026-11-16')
    expect(dueDayKey(pinned, 'America/Los_Angeles')).toBe('2026-11-15')
  })

  it('keeps all-day and floating on their own date in any zone', () => {
    expect(dueDayKey(dueOfText('x due:2026-11-15T23:30')!, 'Pacific/Auckland')).toBe('2026-11-15')
    expect(dueDayKey(dueOfText('x due:2026-11-15')!, 'Pacific/Kiritimati')).toBe('2026-11-15')
  })

  it('colours by day only: a time earlier today is not overdue', () => {
    expect(dueTone(dueOfText('x due:2026-11-15T00:01')!, false, '2026-11-15', 'UTC')).toBe('upcoming')
    expect(dueTone(dueOfText('x due:2026-11-14T23:59')!, false, '2026-11-15', 'UTC')).toBe('overdue')
    expect(dueTone(pinned, false, '2026-11-16', 'America/Los_Angeles')).toBe('overdue')
    expect(dueTone(pinned, false, '2026-11-16', 'Pacific/Auckland')).toBe('upcoming')
    expect(dueTone(pinned, true, '2026-11-16', 'America/Los_Angeles')).toBe('done')
  })
})

describe('formatDueChip', () => {
  const due = (text: string): TaskDue => dueOfText(text)!

  it('labels an all-day due as before, without the token in the title', () => {
    expect(formatDueChip(due('x due:2026-11-15'), '2026-11-15', 'UTC', { token: 'due:2026-11-15' })).toEqual({
      label: 'Today',
      title: 'Due today'
    })
  })

  it('adds a floating due its own wall time in any zone', () => {
    expect(formatDueChip(due('x due:2026-11-16T09:00'), '2026-11-15', 'Pacific/Auckland').label).toBe('Tomorrow 09:00')
  })

  it('shows a pinned due in the device zone with its origin city', () => {
    const token = 'due:2026-11-16T09:00-05:00[America/New_York]'
    expect(formatDueChip(due(`x ${token}`), '2026-11-16', 'Europe/Berlin', { token })).toEqual({
      label: 'Today 15:00 (09:00 New York)',
      title: `Due today 15:00 (09:00 New York) · ${token}`
    })
  })

  it('names an offset-only origin as UTC, UTC+1, UTC+5:30 or UTC−5', () => {
    expect(formatDueChip(due('x due:2026-11-16T09:00+01:00'), '2026-11-16', 'America/New_York').label).toBe('Today 03:00 (09:00 UTC+1)')
    expect(formatDueChip(due('x due:2026-11-16T09:00+05:30'), '2026-11-16', 'UTC').label).toBe('Today 03:30 (09:00 UTC+5:30)')
    expect(formatDueChip(due('x due:2026-11-16T09:00-05:00'), '2026-11-16', 'UTC').label).toBe('Today 14:00 (09:00 UTC\u22125)')
    expect(formatDueChip(due('x due:2026-11-16T09:00-09:30'), '2026-11-16', 'UTC').label).toBe('Today 18:30 (09:00 UTC\u22129:30)')
    expect(formatDueChip(due('x due:2026-11-15T20:00Z'), '2026-11-15', 'Pacific/Auckland').label).toBe('Tomorrow 09:00 (Sun 20:00 UTC)')
    expect(formatDueChip(due('x due:2026-11-15T20:00Z'), '2026-11-15', 'America/Los_Angeles').label).toBe('Today 12:00 (20:00 UTC)')
  })

  it('adds the origin weekday when the origin day is later than the device day', () => {
    expect(formatDueChip(due('x due:2026-11-16T09:00+14:00[Pacific/Kiritimati]'), '2026-11-16', 'Europe/Berlin').label).toBe(
      'Yesterday 20:00 (Mon 09:00 Kiritimati)'
    )
  })

  it('adds the origin weekday when the origin day is earlier than the device day', () => {
    expect(formatDueChip(due('x due:2026-11-15T22:00-08:00[America/Los_Angeles]'), '2026-11-16', 'Asia/Tokyo').label).toBe(
      'Today 15:00 (Sun 22:00 Los Angeles)'
    )
  })

  it('adds the origin weekday across a month boundary', () => {
    expect(formatDueChip(due('x due:2026-12-01T08:00+13:00[Pacific/Auckland]'), '2026-11-16', 'UTC').label).toBe(
      'Nov 30 19:00 (Tue 08:00 Auckland)'
    )
  })

  it('adds the origin weekday across a year boundary', () => {
    expect(formatDueChip(due('x due:2026-12-31T20:00-05:00[America/New_York]'), '2026-11-16', 'Asia/Tokyo').label).toBe(
      'Jan 1, 2027 10:00 (Thu 20:00 New York)'
    )
  })

  it('omits the origin weekday when both days are the same', () => {
    const label = formatDueChip(due('x due:2026-11-16T09:00-05:00[America/New_York]'), '2026-11-16', 'Europe/Berlin').label
    expect(label).toBe('Today 15:00 (09:00 New York)')
    expect(label).not.toMatch(/\((Sun|Mon|Tue|Wed|Thu|Fri|Sat) /)
  })

  it('shows no origin when the offsets agree, even in another zone', () => {
    expect(formatDueChip(due('x due:2026-11-16T09:00+01:00[Europe/Paris]'), '2026-11-16', 'Europe/Berlin').label).toBe('Today 09:00')
    expect(formatDueChip(due('x due:2026-11-16T09:00+01:00'), '2026-11-16', 'Europe/Berlin').label).toBe('Today 09:00')
  })

  it('names a multi-word city with spaces', () => {
    expect(formatDueChip(due('x due:2026-11-16T09:00-08:00[America/Los_Angeles]'), '2026-11-16', 'UTC').label).toBe('Today 17:00 (09:00 Los Angeles)')
  })

  it('words the overdue and done tones', () => {
    const token = 'due:2026-11-10T09:00'
    expect(formatDueChip(due(`x ${token}`), '2026-11-15', 'UTC', { token }).title).toBe(`Overdue · Nov 10 09:00 · ${token}`)
    expect(formatDueChip(due(`x ${token}`), '2026-11-11', 'UTC', { token, done: true }).title).toBe(`Done · due yesterday 09:00 · ${token}`)
  })
})

describe('zone names', () => {
  it.each(['+01:00', 'EST', 'GMT', 'Mars'])('treats [%s] as an unknown zone and uses the offset', (zone) => {
    expect(dueOfText(`x due:2026-11-15T09:00+01:00[${zone}]`)).toMatchObject({
      kind: 'pinned',
      instant: utc(2026, 11, 15, 8, 0),
      offsetMinutes: 60,
      zone: null
    })
  })

  it('accepts UTC in any case, as UTC', () => {
    expect(dueOfText('x due:2026-11-15T09:00+01:00[utc]')).toMatchObject({ instant: utc(2026, 11, 15, 9, 0), offsetMinutes: 0, zone: 'UTC' })
  })

  it('takes Intl casing for a zone written in lower case', () => {
    const d = dueOfText('x due:2026-11-16T09:00-05:00[america/new_york]')!
    expect(d).toMatchObject({ zone: 'America/New_York', instant: utc(2026, 11, 16, 14, 0) })
    expect(formatDueChip(d, '2026-11-16', 'Europe/Berlin').label).toBe('Today 15:00 (09:00 New York)')
  })

  it('keeps an alias as written rather than the legacy name ICU resolves it to', () => {
    const d = dueOfText('x due:2026-11-16T09:00+05:30[Asia/Kolkata]')!
    expect(d).toMatchObject({ zone: 'Asia/Kolkata', instant: utc(2026, 11, 16, 3, 30), offsetMinutes: 330 })
    expect(formatDueChip(d, '2026-11-16', 'Europe/Berlin').label).toBe('Today 04:30 (09:00 Kolkata)')
  })

  it('shows an Etc/* zone as an offset (its name inverts the sign)', () => {
    const d = dueOfText('x due:2026-11-16T09:00-05:00[Etc/GMT+5]')!
    expect(d).toMatchObject({ zone: 'Etc/GMT+5', offsetMinutes: -300 })
    expect(formatDueChip(d, '2026-11-16', 'UTC').label).toBe('Today 14:00 (09:00 UTC\u22125)')
  })

  it('reads a +05:45 zone', () => {
    const d = dueOfText('x due:2026-11-16T09:00+05:45[Asia/Kathmandu]')!
    expect(d).toMatchObject({ instant: utc(2026, 11, 16, 3, 15), offsetMinutes: 345 })
    expect(formatDueChip(d, '2026-11-16', 'UTC').label).toBe('Today 03:15 (09:00 Kathmandu)')
  })

  it('caps the zone formatter cache', () => {
    for (let h = -12; h <= 14; h++) for (const zone of [`Etc/GMT${h < 0 ? '' : '+'}${h}`]) dueOfText(`x due:2026-11-16T09:00Z[${zone}]`)
    for (const zone of Intl.supportedValuesOf('timeZone').slice(0, 100)) dueOfText(`x due:2026-11-16T09:00Z[${zone}]`)
    expect(cachedZoneCount()).toBeLessThanOrEqual(64)
  })
})

describe('clock format', () => {
  it('follows the locale: 12-hour where the device uses it', () => {
    setClockLocale('en-US')
    try {
      const label = formatDueChip(dueOfText('x due:2026-11-16T09:00-05:00[America/New_York]')!, '2026-11-16', 'Europe/Berlin').label
      expect(label.replace(/\s/g, ' ')).toBe('Today 3:00 PM (9:00 AM New York)')
      expect(formatDueChip(dueOfText('x due:2026-11-16T21:05')!, '2026-11-16', 'UTC').label.replace(/\s/g, ' ')).toBe('Today 9:05 PM')
    } finally {
      setClockLocale('en-GB')
    }
  })

  describe('the device 12/24-hour override', () => {
    const chip = (text: string, zone: string, locale: string, hourCycle: 'h12' | 'h23' | null): string => {
      setClockLocale(locale)
      try {
        return formatDueChip(dueOfText(text)!, '2026-11-16', zone, { hourCycle }).label.replace(/\s/g, ' ')
      } finally {
        setClockLocale('en-GB')
      }
    }
    const pinned = 'x due:2026-11-16T09:00-05:00[America/New_York]'

    it('en-US with 24-hour on reads 24-hour, origin included', () => {
      expect(chip(pinned, 'Europe/Berlin', 'en-US', 'h23')).toBe('Today 15:00 (09:00 New York)')
      expect(chip('x due:2026-11-16T21:05', 'UTC', 'en-US', 'h23')).toBe('Today 21:05')
    })

    it('en-GB with 12-hour forced reads 12-hour, unpadded, in its own day-period form', () => {
      expect(chip(pinned, 'Europe/Berlin', 'en-GB', 'h12')).toBe('Today 3:00 pm (9:00 am New York)')
      expect(chip('x due:2026-11-16T00:05', 'UTC', 'en-GB', 'h12')).toBe('Today 12:05 am')
    })

    it('de-DE with 12-hour forced', () => {
      expect(chip('x due:2026-11-16T21:05', 'UTC', 'de-DE', 'h12')).toBe('Today 9:05 PM')
    })

    it('null follows the locale', () => {
      expect(chip(pinned, 'Europe/Berlin', 'en-US', null)).toBe('Today 3:00 PM (9:00 AM New York)')
      expect(chip(pinned, 'Europe/Berlin', 'en-GB', null)).toBe('Today 15:00 (09:00 New York)')
    })

    it('the title carries the same clock', () => {
      setClockLocale('en-US')
      try {
        const due = dueOfText('x due:2026-11-16T21:05')!
        expect(formatDueChip(due, '2026-11-16', 'UTC', { hourCycle: 'h23', token: 'due:2026-11-16T21:05' }).title).toBe('Due today 21:05 · due:2026-11-16T21:05')
      } finally {
        setClockLocale('en-GB')
      }
    })
  })

  it('keeps the origin weekday in fixed English whatever the locale', () => {
    setClockLocale('de-DE')
    try {
      expect(formatDueChip(dueOfText('x due:2026-11-16T09:00+14:00[Pacific/Kiritimati]')!, '2026-11-16', 'Europe/Berlin').label).toBe(
        'Yesterday 20:00 (Mon 09:00 Kiritimati)'
      )
    } finally {
      setClockLocale('en-GB')
    }
  })
})

describe('DST in the southern hemisphere and half-hour shifts', () => {
  it.each([
    ['Lord Howe spring gap (30 min): 02:15 is 02:45 +11:00', 'due:2026-10-04T02:15+10:30[Australia/Lord_Howe]', utc(2026, 10, 3, 15, 45), 660],
    ['Lord Howe autumn overlap: +10:30 picks the later 01:45', 'due:2026-04-05T01:45+10:30[Australia/Lord_Howe]', utc(2026, 4, 4, 15, 15), 630],
    ['Lord Howe autumn overlap: +11:00 picks the earlier 01:45', 'due:2026-04-05T01:45+11:00[Australia/Lord_Howe]', utc(2026, 4, 4, 14, 45), 660],
    ['Lord Howe outside a change', 'due:2026-07-01T09:00+11:00[Australia/Lord_Howe]', utc(2026, 6, 30, 22, 30), 630],
    ['Sydney spring gap: 02:30 is 03:30 +11:00', 'due:2026-10-04T02:30+10:00[Australia/Sydney]', utc(2026, 10, 3, 16, 30), 660],
    ['Sydney autumn overlap: +10:00 picks the later 02:30', 'due:2026-04-05T02:30+10:00[Australia/Sydney]', utc(2026, 4, 4, 16, 30), 600],
    ['Sydney autumn overlap: a matching-neither offset takes the earlier 02:30', 'due:2026-04-05T02:30+03:00[Australia/Sydney]', utc(2026, 4, 4, 15, 30), 660]
  ])('%s', (_name, token, instant, offsetMinutes) => {
    expect(dueOfText(`x ${token}`)).toMatchObject({ kind: 'pinned', instant, offsetMinutes })
  })
})
