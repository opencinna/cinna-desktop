/** Deliberately bounded cron grammar. This parser never evaluates code. */
export interface ScheduleCron {
  fields: ReadonlySet<number>[]
  dayWildcard: boolean
  weekdayWildcard: boolean
}

const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const

export function parseScheduleCron(value: string): ScheduleCron {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Use a five-field numeric cron schedule.')
  const fields = value.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Use five cron fields: minute hour day month weekday.')
  const parsed = fields.map((field, index) => {
    const [min, max] = bounds[index]
    const values = new Set<number>()
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
      if (!match) throw new Error('Cron fields support numbers, *, lists, ranges and positive steps.')
      const step = match[2] === undefined ? 1 : Number(match[2])
      if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) throw new Error('A cron step is outside its field range.')
      let start: number, end: number
      if (match[1] === '*') { start = min; end = max }
      else {
        const range = match[1].split('-').map(Number)
        start = range[0]
        end = range[1] ?? (match[2] ? max : start)
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) throw new Error('A cron value is outside its field range.')
      for (let item = start; item <= end; item += step) values.add(index === 4 && item === 7 ? 0 : item)
    }
    return values
  })
  // A leading wildcard, including */n, follows the wildcard day rule. An
  // explicit full range remains restricted, matching ordinary cron semantics.
  return { fields: parsed, dayWildcard: fields[2].startsWith('*'), weekdayWildcard: fields[4].startsWith('*') }
}

export function scheduleTimezone(value?: string | null): string {
  const zone = value ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof zone !== 'string' || !zone || zone.length > 128 || /^[+-]/.test(zone)) throw new Error('Choose a valid IANA timezone.')
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone }
  catch { throw new Error('Choose a valid IANA timezone, such as Europe/Berlin.') }
}

export function scheduleMinute(cron: ScheduleCron, timezone: string, now: number): { matches: boolean; civilKey: string; utcMinute: number } {
  if (!Number.isFinite(now)) throw new Error('The schedule clock is unavailable.')
  const utcMinute = Math.floor(now / 60000)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utcMinute * 60000))
  const value = (name: string) => parts.find((part) => part.type === name)!.value
  const year = value('year'), month = value('month'), day = value('day'), hour = value('hour'), minute = value('minute')
  const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()
  const [minutes, hours, days, months, weekdays] = cron.fields
  const dayMatch = days.has(Number(day)), weekdayMatch = weekdays.has(weekday)
  const calendarMatch = cron.dayWildcard || cron.weekdayWildcard ? dayMatch && weekdayMatch : dayMatch || weekdayMatch
  return { matches: minutes.has(Number(minute)) && hours.has(Number(hour)) && months.has(Number(month)) && calendarMatch,
    civilKey: `${timezone}|${year}-${month}-${day}T${hour}:${minute}`, utcMinute }
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/**
 * Find a future UTC instant by visiting calendar dates and allowed fields, never
 * by replaying minutes since the previous run. A full Gregorian cycle bounds
 * impossible rules while including sparse leap-day/weekday combinations.
 *
 * Ambiguous civil minutes belong to their FIRST UTC occurrence. Selecting the
 * earliest mapping before checking `after` prevents a fall-back hour replay,
 * even when a fresh binding is created during its second occurrence.
 */
export function nextScheduleOccurrence(
  value: ScheduleCron | string,
  timezone: string,
  after: number,
  excludedCivilKey?: string | null
): number {
  if (!Number.isFinite(after) || !Number.isFinite(new Date(after).getTime())) throw new Error('The schedule clock is unavailable.')
  const cron = typeof value === 'string' ? parseScheduleCron(value) : value
  const zone = scheduleTimezone(timezone)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  })
  const civil = (instant: number): number => {
    const parts = formatter.formatToParts(new Date(instant))
    const part = (name: string) => Number(parts.find((item) => item.type === name)!.value)
    const date = new Date(0)
    date.setUTCFullYear(part('year'), part('month') - 1, part('day'))
    date.setUTCHours(part('hour'), part('minute'), 0, 0)
    return date.getTime()
  }
  const firstCivil = civil(after)
  const firstDay = Math.floor(firstCivil / DAY) * DAY
  const [minutes, hours, days, months, weekdays] = cron.fields
  const orderedHours = [...hours].sort((a, b) => a - b)
  const orderedMinutes = [...minutes].sort((a, b) => a - b)
  for (let offset = 0; offset <= 146097; offset++) {
    const dateInstant = firstDay + offset * DAY
    const date = new Date(dateInstant)
    if (!Number.isFinite(date.getTime())) break
    if (!months.has(date.getUTCMonth() + 1)) continue
    const dayMatch = days.has(date.getUTCDate()), weekdayMatch = weekdays.has(date.getUTCDay())
    if (!(cron.dayWildcard || cron.weekdayWildcard ? dayMatch && weekdayMatch : dayMatch || weekdayMatch)) continue

    // Probe both sides of this civil date, including half-hour transitions and
    // date-line changes. Each candidate is then round-tripped through Intl;
    // nonexistent spring times (and skipped dates) therefore cannot match.
    const offsets = new Set<number>()
    for (let probe = -2 * DAY; probe <= 2 * DAY; probe += DAY / 2) {
      const instant = dateInstant + probe
      offsets.add(civil(instant) - instant)
    }
    for (const hour of orderedHours) {
      for (const minute of orderedMinutes) {
        const target = dateInstant + (hour * 60 + minute) * MINUTE
        if (offset === 0 && target < firstCivil) continue
        let earliest = Infinity
        for (const zoneOffset of offsets) {
          const candidate = target - zoneOffset
          if (candidate < earliest && civil(candidate) === target) earliest = candidate
        }
        if (!Number.isFinite(earliest) || earliest <= after) continue
        if (excludedCivilKey && scheduleMinute(cron, zone, earliest).civilKey === excludedCivilKey) continue
        return earliest
      }
    }
  }
  throw new Error('This cron schedule has no possible occurrence. Choose a valid calendar date and time.')
}
