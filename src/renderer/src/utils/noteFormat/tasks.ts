// Todos inside notes, read the way Cinna Assistant (mobile) reads them. A port
// of the read side of the mobile app's `src/notes/tasks.ts`, rule for rule, so
// one note shows the same due dates on both apps. Pure and dependency-free
// (tested in tasks.test.ts); the desktop never rewrites a body.
//
//   - [ ] buy milk due:2026-11-15
//   - [x] call mom 📅 2026-11-14 ✅ 2026-11-14
//
// Due date: `due:YYYY-MM-DD` (what Cinna writes: ASCII, dictation-friendly) or
// Obsidian Tasks' `📅 YYYY-MM-DD`. The first match on the line wins; every due
// token is stripped from the display text. Obsidian's done-date `✅ YYYY-MM-DD`
// is tolerated and stripped. Lines inside fenced code blocks are not tasks.
//
// Timed due (Phase 2d contract, `due:` only; `📅` stays date-only):
//   due:2026-11-15T09:00                           floating: device wall clock
//   due:2026-11-15T09:00+01:00 (or +0100, Z)       pinned: an exact instant
//   due:2026-11-15T09:00-05:00[America/New_York]   pinned zoned: zone wins
// Optional `:ss`. A `[zone]` only after an offset. An unknown zone falls back
// to the offset; an unusable offset (HH > 23 or MM > 59) falls back to the
// zone; with neither the token is floating. The text is never normalised.

import { fencedLineMask } from './tags'

export interface ParsedTask {
  /** 0-based index among the note's tasks. */
  ordinal: number
  /** 0-based line number in the body. */
  line: number
  /** The line exactly as stored (without a trailing `\r`). */
  rawLine: string
  done: boolean
  /** The item text with due / done-date tokens stripped. */
  text: string
  /** The due token's written date (YYYY-MM-DD) or null. */
  dueDate: string | null
  /** The due date with its time and kind, or null. */
  due: TaskDue | null
}

/** A task's due: a whole day, a floating wall-clock time, or a pinned instant. */
export type TaskDue =
  | { kind: 'all-day'; date: string }
  /** `time` is 'HH:mm' as written (seconds are read and never shown). */
  | { kind: 'floating'; date: string; time: string }
  /**
   * `date`/`time` as written. `instant` in epoch ms; `offsetMinutes` the
   * offset actually used (the zone's at that instant when the zone wins);
   * `zone` the canonical name of a valid zone (see `resolveZone`), else null.
   */
  | { kind: 'pinned'; date: string; time: string; instant: number; offsetMinutes: number; zone: string | null }

/** A GFM task item line: [all, open, mark, close, item]. Spacing as loose as a
 *  markdown editor's checkbox. */
export const TASK = /^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.+)$/
/** A line without a trailing `\r` (CRLF bodies from other clients). */
const bare = (line: string): string => line.replace(/\r$/, '')

/**
 * A due or done-date token: [full match, leading space, ascii date, hour,
 * minute, second, offset, zone, emoji date]. A zone only after an offset.
 */
export const TOKEN =
  /(^|\s)(?:due:(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:(Z|[+-]\d{2}:?\d{2})(?:\[([^\]\s]+)\])?)?)?|📅️?\s*(\d{4}-\d{2}-\d{2})|✅️?\s*\d{4}-\d{2}-\d{2})(?=\s|$)/gu

/** A calendar-valid YYYY-MM-DD. */
export function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/** A due token inside a run of text. */
export interface DueToken {
  start: number
  end: number
  /** The written date. */
  date: string
  due: TaskDue
}

/** The device's current IANA zone. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Formatters by zone, oldest first; capped so odd zones in notes cannot grow it. */
const formatters = new Map<string, Intl.DateTimeFormat | null>()
const FORMATTER_CAP = 64

/** A formatter for `zone`'s wall clock, or null when `Intl` rejects the zone. */
function wallFormatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone)
  if (f === undefined) {
    if (formatters.size >= FORMATTER_CAP) formatters.delete(formatters.keys().next().value as string)
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    } catch {
      f = null
    }
    formatters.set(zone, f)
  }
  return f
}

/** An IANA-shaped zone name (`Area/City`, `Etc/GMT+5`). */
const IANA_ZONE = /^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+\-]+)+$/

/**
 * A token's `[zone]` if valid, else null (unknown: the offset is used). It
 * must be IANA-shaped or `UTC` (any case), and accepted by `Intl`: `[+01:00]`,
 * `[EST]` and `[GMT]` are unknown. The name comes back in `Intl`'s casing
 * (`america/new_york` → `America/New_York`), but an alias keeps its written
 * name: ICU resolves `Asia/Kolkata` to the legacy `Asia/Calcutta`.
 */
export function resolveZone(name: string): string | null {
  if (!IANA_ZONE.test(name) && name.toUpperCase() !== 'UTC') return null
  const f = wallFormatter(name)
  if (!f) return null
  const resolved = f.resolvedOptions().timeZone
  return resolved.toLowerCase() === name.toLowerCase() ? resolved : name
}

/** Test hook: how many zone formatters are cached. */
export function cachedZoneCount(): number {
  return formatters.size
}

/** The wall clock of `instant` in `zone` as UTC-based ms (seconds precision). */
function wallMs(instant: number, zone: string): number {
  const f = wallFormatter(zone)
  if (!f) throw new RangeError(`Invalid time zone: ${zone}`)
  const parts: Record<string, number> = {}
  for (const p of f.formatToParts(instant)) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

/** `zone`'s UTC offset at `instant`, in minutes. */
export function zoneOffsetMinutes(instant: number, zone: string): number {
  return Math.round((wallMs(instant, zone) - Math.floor(instant / 1000) * 1000) / 60_000)
}

/**
 * The instant of a wall-clock time (as UTC-based ms) in `zone`. In a DST gap
 * it moves forward by the gap; in an overlap it takes the earlier instant
 * (Temporal's "compatible").
 */
function zonedInstant(wall: number, zone: string): number {
  const before = zoneOffsetMinutes(wall - 86_400_000, zone)
  const after = zoneOffsetMinutes(wall + 86_400_000, zone)
  const fits = [before, after]
    .map((o) => wall - o * 60_000)
    .filter((t) => zoneOffsetMinutes(t, zone) * 60_000 === wall - t)
  if (fits.length > 0) return Math.min(...fits)
  return wall - before * 60_000
}

/** An offset token's minutes, or null when unusable (HH > 23 or MM > 59). */
function offsetMinutesOf(token: string): number | null {
  if (token === 'Z') return 0
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(token)
  if (!m) return null
  const [h, mi] = [Number(m[2]), Number(m[3])]
  if (h > 23 || mi > 59) return null
  const total = h * 60 + mi
  // `-00:00` is UTC too (not -0).
  return m[1] === '-' && total > 0 ? -total : total
}

/** The due a TOKEN match stands for, or null when its date or time is not real. */
function dueOf(m: RegExpMatchArray): TaskDue | null {
  if (m[8] !== undefined) return isValidDate(m[8]) ? { kind: 'all-day', date: m[8] } : null
  const date = m[2]
  if (!date || !isValidDate(date)) return null
  if (m[3] === undefined) return { kind: 'all-day', date }
  const [h, mi, s] = [Number(m[3]), Number(m[4]), Number(m[5] ?? 0)]
  if (h > 23 || mi > 59 || s > 59) return null
  const time = `${m[3]}:${m[4]}`
  if (m[6] === undefined) return { kind: 'floating', date, time }
  const wall = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, mi, s)
  const zone = m[7] !== undefined ? resolveZone(m[7]) : null
  if (zone) {
    const instant = zonedInstant(wall, zone)
    return { kind: 'pinned', date, time, instant, offsetMinutes: zoneOffsetMinutes(instant, zone), zone }
  }
  const offset = offsetMinutesOf(m[6])
  if (offset === null) return { kind: 'floating', date, time }
  return { kind: 'pinned', date, time, instant: wall - offset * 60_000, offsetMinutes: offset, zone: null }
}

/** Due tokens (both syntaxes) in a run of text, in order. Done-date tokens are
 *  not returned, nor tokens whose date or time is not real. Offsets cover the
 *  token itself (not the leading space). */
export function findDueTokens(text: string): DueToken[] {
  const out: DueToken[] = []
  for (const m of text.matchAll(TOKEN)) {
    const due = dueOf(m)
    if (!due) continue
    const start = (m.index ?? 0) + m[1].length
    out.push({ start, end: (m.index ?? 0) + m[0].length, date: due.date, due })
  }
  return out
}

/** The due of an item's text: the first valid due token, else null. */
export function dueOfText(text: string): TaskDue | null {
  return findDueTokens(text)[0]?.due ?? null
}

/** The due date of an item's text: the first valid due token's written date, else null. */
export function dueDateOf(text: string): string | null {
  return findDueTokens(text)[0]?.date ?? null
}

/** The item text with every due / done-date token removed, whitespace tidied. */
export function stripTaskTokens(text: string): string {
  return text.replace(TOKEN, '$1').replace(/\s{2,}/g, ' ').trim()
}

/** Every task item in a note body, in order. */
export function parseTasks(body: string): ParsedTask[] {
  const lines = body.split('\n')
  const fenced = fencedLineMask(lines)
  const out: ParsedTask[] = []
  lines.forEach((full, line) => {
    if (fenced[line]) return
    const rawLine = bare(full)
    const m = TASK.exec(rawLine)
    if (!m) return
    const item = m[4]
    const due = dueOfText(item)
    out.push({
      ordinal: out.length,
      line,
      rawLine,
      done: m[2] !== ' ',
      text: stripTaskTokens(item),
      dueDate: due?.date ?? null,
      due
    })
  })
  return out
}

/** Local calendar date as YYYY-MM-DD (the device's day, not UTC's). */
export function localDateKey(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Whole days from `today` to `date` (both YYYY-MM-DD); negative = past. */
export function daysUntil(date: string, today: string): number {
  const utc = (s: string): number => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
  return Math.round((utc(date) - utc(today)) / 86_400_000)
}

/** A due chip's label: Today / Tomorrow / Yesterday, else "Nov 15" (with the
 *  year when it isn't this year's). */
export function formatDueLabel(date: string, today: string): string {
  const d = daysUntil(date, today)
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  if (d === -1) return 'Yesterday'
  const label = `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`
  return date.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${date.slice(0, 4)}`
}

/** YYYY-MM-DD of a UTC-based wall-clock ms. */
const dayOfWall = (wall: number): string => new Date(wall).toISOString().slice(0, 10)
/** HH:mm of a UTC-based wall-clock ms. */
const timeOfWall = (wall: number): string => new Date(wall).toISOString().slice(11, 16)

/**
 * The day a due belongs to (Today strip, overdue, the chip): all-day and
 * floating use their own date; pinned uses the instant's date in `deviceZone`.
 */
export function dueDayKey(due: TaskDue, deviceZone: string = deviceTimeZone()): string {
  return due.kind === 'pinned' ? wallDateKey(due.instant, deviceZone) : due.date
}

/** The calendar date (YYYY-MM-DD) of `instant` in `zone`. */
export function wallDateKey(instant: number, zone: string = deviceTimeZone()): string {
  return dayOfWall(wallMs(instant, zone))
}

/** Where a pinned due was written: its zone's city, else (offset-only, `UTC`,
 *  `Etc/*`, whose names invert the sign) `UTC±HH:MM` / `UTC`. */
function originName(due: Extract<TaskDue, { kind: 'pinned' }>): string {
  if (due.zone && due.zone.includes('/') && !due.zone.startsWith('Etc/')) return (due.zone.split('/').pop() ?? due.zone).replace(/_/g, ' ')
  const o = due.offsetMinutes
  if (o === 0) return 'UTC'
  const abs = Math.abs(o)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `UTC${o < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

export type DueTone = 'overdue' | 'done' | 'upcoming'

/** A chip's tone: muted when checked, warning when its day is before today. A
 *  timed due later today is not overdue, even after its time has passed. */
export function dueTone(due: TaskDue, done: boolean, today: string, deviceZone: string = deviceTimeZone()): DueTone {
  return done ? 'done' : dueDayKey(due, deviceZone) < today ? 'overdue' : 'upcoming'
}

/** "Today" reads "today" inside a sentence; a date stays as it is. */
function inSentence(label: string): string {
  return label.replace(/^(Today|Tomorrow|Yesterday)\b/, (w) => w.toLowerCase())
}

/**
 * A due chip's text and its title. The day part as `formatDueLabel` names the
 * day bucket; a timed due adds its HH:mm in `deviceZone`, and a pinned due
 * whose offset differs from the device's at that instant adds where it was
 * written: "Today 15:00 (09:00 New York)". The title says the tone in words
 * (Overdue · … / Due … / Done · due …) and, for a timed due, the token as
 * written (`token`).
 */
export function formatDueChip(
  due: TaskDue,
  today: string,
  deviceZone: string = deviceTimeZone(),
  options: { done?: boolean; token?: string } = {}
): { label: string; title: string } {
  let label = formatDueLabel(dueDayKey(due, deviceZone), today)
  if (due.kind === 'floating') label += ` ${due.time}`
  if (due.kind === 'pinned') {
    label += ` ${timeOfWall(wallMs(due.instant, deviceZone))}`
    if (zoneOffsetMinutes(due.instant, deviceZone) !== due.offsetMinutes) {
      label += ` (${timeOfWall(due.instant + due.offsetMinutes * 60_000)} ${originName(due)})`
    }
  }
  const tone = dueTone(due, options.done === true, today, deviceZone)
  let title = tone === 'overdue' ? `Overdue · ${label}` : tone === 'done' ? `Done · due ${inSentence(label)}` : `Due ${inSentence(label)}`
  if (due.kind !== 'all-day' && options.token) title += ` · ${options.token}`
  return { label, title }
}
