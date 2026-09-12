import { describe, expect, it } from 'vitest'
import { parseScheduleCron, scheduleMinute, scheduleTimezone } from './scheduleCron'

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
