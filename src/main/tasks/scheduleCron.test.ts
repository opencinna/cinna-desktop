import { describe, expect, it } from 'vitest'
import { nextScheduleOccurrence, parseScheduleCron, scheduleMinute, scheduleTimezone } from './scheduleCron'

const match = (cron: string, instant: string, zone = 'UTC') => scheduleMinute(parseScheduleCron(cron), zone, Date.parse(instant))

describe('local schedule cron', () => {
  it('supports bounded numeric lists, ranges, steps and Sunday aliases', () => {
    expect(match('5,15-25/5 8-10 1-31 1-12 0,7', '2026-09-13T09:20:00Z').matches).toBe(true)
    expect(match('5/10 * * * *', '2026-09-13T09:25:00Z').matches).toBe(true)
    expect(match('*/15 * * * *', '2026-09-13T09:16:00Z').matches).toBe(false)
  })
  it.each(['', '* * * *', '* * * * * *', '@daily', '0 0 * JAN MON', '60 * * * *', '* 24 * * *', '* * 0 * *',
    '* * * 13 *', '* * * * 8', '*/0 * * * *', '1-0 * * * *', ',1 * * * *', '1, * * * *', '1//2 * * * *',
    '1.5 * * * *', '1L * * * *', '*/9999999999999999999 * * * *'])('refuses invalid cron %s', (cron) => {
    expect(() => parseScheduleCron(cron)).toThrow()
  })
  it('uses OR only when both calendar day fields are restricted', () => {
    expect(match('0 9 1 * 1', '2026-09-14T09:00:00Z').matches).toBe(true)
    expect(match('0 9 1 * 1', '2026-10-01T09:00:00Z').matches).toBe(true)
    expect(match('0 9 * * 1', '2026-09-15T09:00:00Z').matches).toBe(false)
    expect(match('0 9 */2 * 1', '2026-09-14T09:00:00Z').matches).toBe(false)
    expect(match('0 9 1-31 * 1', '2026-09-15T09:00:00Z').matches).toBe(true)
  })
  it('uses the same civil key for repeated autumn minutes, including half-hour DST', () => {
    const berlin = ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'].map((now) => match('30 2 * * *', now, 'Europe/Berlin'))
    expect(berlin[0].matches && berlin[1].matches).toBe(true)
    expect(berlin[0].civilKey).toBe(berlin[1].civilKey)
    expect(berlin[0].utcMinute).not.toBe(berlin[1].utcMinute)
    const lordHowe = ['2026-04-04T14:45:00Z', '2026-04-04T15:15:00Z'].map((now) => match('45 1 * * *', now, 'Australia/Lord_Howe'))
    expect(lordHowe[0].matches && lordHowe[1].matches).toBe(true)
    expect(lordHowe[0].civilKey).toBe(lordHowe[1].civilKey)
  })
  it('skips the spring missing hour and projects midnight as zero', () => {
    for (const hour of ['00', '01', '02', '03']) expect(match('30 2 * * *', `2026-03-29T${hour}:30:00Z`, 'Europe/Berlin').matches).toBe(false)
    expect(match('0 0 * * *', '2026-09-12T00:00:00Z').civilKey).toBe('UTC|2026-09-12T00:00')
  })
  it('validates and resolves timezone once without accepting offset strings', () => {
    expect(scheduleTimezone('Europe/Berlin')).toBe('Europe/Berlin')
    expect(scheduleTimezone()).toBeTruthy()
    for (const zone of ['', 'Mars/Olympus', '+02:00']) expect(() => scheduleTimezone(zone)).toThrow()
  })
})

describe('next local schedule occurrence', () => {
  const next = (cron: string, after: string, zone = 'UTC', excludedCivilKey?: string) =>
    new Date(nextScheduleOccurrence(cron, zone, Date.parse(after), excludedCivilKey)).toISOString()

  it('is strictly future and skips missed occurrences directly', () => {
    expect(next('0 8 * * 1-5', '2026-09-21T08:00:00Z')).toBe('2026-09-22T08:00:00.000Z')
    expect(next('0 8 * * 1-5', '2026-09-26T11:00:00Z')).toBe('2026-09-28T08:00:00.000Z')
    expect(next('0 9-18 * * 1-5', '2026-09-21T13:40:00Z')).toBe('2026-09-21T14:00:00.000Z')
    expect(next('* * * * *', '2026-09-21T13:40:59.999Z')).toBe('2026-09-21T13:41:00.000Z')
  })

  it('keeps both workday templates and all selected custom hours', () => {
    expect(next('0 9-18 * * 1-5', '2026-09-21T17:59:59Z')).toBe('2026-09-21T18:00:00.000Z')
    expect(next('0 9-18 * * 1-5', '2026-09-25T18:00:00Z')).toBe('2026-09-28T09:00:00.000Z')
    expect(next('0 0,12,23 * * 0,1', '2026-09-21T12:00:00Z')).toBe('2026-09-21T23:00:00.000Z')
  })

  it('searches sparse leap dates across a non-leap century and rejects impossible dates', () => {
    expect(next('0 0 29 2 *', '2096-02-29T00:00:00Z')).toBe('2104-02-29T00:00:00.000Z')
    expect(() => next('0 0 30 2 *', '2026-01-01T00:00:00Z')).toThrow('no possible occurrence')
    // Restricted calendar fields are OR, so February 30 OR Monday is valid.
    expect(next('0 0 30 2 1', '2026-01-01T00:00:00Z')).toBe('2026-02-02T00:00:00.000Z')
    // A leading wildcard follows AND semantics and can have >8-year gaps.
    expect(next('0 0 */30 2 1', '2027-02-01T00:00:00Z')).toBe('2038-02-01T00:00:00.000Z')
  })

  it('skips spring gaps and uses a frozen zone with fractional-hour offsets', () => {
    expect(next('30 2 * * *', '2026-03-28T23:00:00Z', 'Europe/Berlin')).toBe('2026-03-30T00:30:00.000Z')
    expect(next('0 8 * * *', '2026-09-21T00:00:00Z', 'Asia/Kathmandu')).toBe('2026-09-21T02:15:00.000Z')
    expect(next('15 2 * * *', '2026-10-03T14:00:00Z', 'Australia/Lord_Howe')).toBe('2026-10-04T15:15:00.000Z')
    expect(next('0 8 * * *', '2011-12-30T00:00:00Z', 'Pacific/Apia')).toBe('2011-12-30T18:00:00.000Z')
  })

  it('never returns the second mapping of a repeated civil minute', () => {
    expect(next('30 2 * * *', '2026-10-25T00:30:00Z', 'Europe/Berlin')).toBe('2026-10-26T01:30:00.000Z')
    expect(next('30 2 * * *', '2026-10-25T01:15:00Z', 'Europe/Berlin')).toBe('2026-10-26T01:30:00.000Z')
    expect(next('45 1 * * *', '2026-04-04T14:45:00Z', 'Australia/Lord_Howe')).toBe('2026-04-05T15:15:00.000Z')
    expect(next('* * * * *', '2026-10-25T00:59:00Z', 'Europe/Berlin')).toBe('2026-10-25T02:00:00.000Z')
    expect(next('0 8 * * *', '2026-09-21T00:00:00Z', 'UTC', 'UTC|2026-09-21T08:00')).toBe('2026-09-22T08:00:00.000Z')
  })

  it('agrees with the matcher and returns a strictly future time for the supported grammar', () => {
    for (const cron of ['*/7 2-20 * * 0,7', '5/10 * 1,15 * 1', '0 0 */2 2-5 2', '*/13 */3 * * *']) {
      for (const zone of ['UTC', 'Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe']) {
        let after = Date.parse('2026-10-24T22:00:00Z')
        for (let index = 0; index < 12; index++) {
          const instant = nextScheduleOccurrence(cron, zone, after)
          expect(instant).toBeGreaterThan(after)
          expect(match(cron, new Date(instant).toISOString(), zone).matches).toBe(true)
          after = instant
        }
      }
    }
  })
})
