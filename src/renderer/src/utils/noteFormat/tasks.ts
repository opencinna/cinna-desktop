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
// is tolerated and stripped. `due:YYYY-MM-DDTHH:mm` is accepted with the time
// ignored (times are reserved). Lines inside fenced code blocks are not tasks.

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
  /** YYYY-MM-DD or null. */
  dueDate: string | null
}

/** A GFM task item line: [all, open, mark, close, item]. Spacing as loose as a
 *  markdown editor's checkbox. */
export const TASK = /^(\s*[-*+]\s+\[)( |x|X)(\]\s+)(.+)$/
/** A line without a trailing `\r` (CRLF bodies from other clients). */
const bare = (line: string): string => line.replace(/\r$/, '')

/** A due or done-date token: [full match, leading space, ascii date, emoji date]. */
export const TOKEN =
  /(^|\s)(?:due:(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2})?|📅️?\s*(\d{4}-\d{2}-\d{2})|✅️?\s*\d{4}-\d{2}-\d{2})(?=\s|$)/gu

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
  date: string
}

/** Due tokens (both syntaxes) in a run of text, in order. Done-date tokens are
 *  not returned. Offsets cover the token itself (not the leading space). */
export function findDueTokens(text: string): DueToken[] {
  const out: DueToken[] = []
  for (const m of text.matchAll(TOKEN)) {
    const date = m[2] ?? m[3]
    if (!date || !isValidDate(date)) continue
    const start = (m.index ?? 0) + m[1].length
    out.push({ start, end: (m.index ?? 0) + m[0].length, date })
  }
  return out
}

/** The due date of an item's text: the first valid due token, else null. */
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
    out.push({
      ordinal: out.length,
      line,
      rawLine,
      done: m[2] !== ' ',
      text: stripTaskTokens(item),
      dueDate: dueDateOf(item)
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
