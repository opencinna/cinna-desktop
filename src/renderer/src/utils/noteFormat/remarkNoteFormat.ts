// Read-view rendering of the note body format Cinna Assistant (mobile) writes:
// inline `#tags` become pills, and a GFM task item with a due date gets a due
// chip with every due / done-date token stripped from its text.
//
// So the read view agrees exactly with the parsers in tags.ts / tasks.ts (and
// so with mobile), every match is computed on the RAW markdown source, line by
// line, the way the parsers read a body; the result is then applied to mdast
// text nodes through their source offsets. The part of a text node that
// cannot be mapped back onto the source is left as it is, and a due chip is
// drawn only when its token was actually taken out of the text.
// Display only: the body is never rewritten.

import { findTagsInLine, fencedLineMask } from './tags'
import { TASK, TOKEN, findDueTokens, formatDueLabel, localDateKey } from './tasks'

interface MdNode {
  type: string
  value?: string
  checked?: boolean | null
  children?: MdNode[]
  position?: { start: { line?: number; offset?: number }; end: { line?: number; offset?: number } }
  data?: Record<string, unknown>
}

export interface RemarkNoteFormatOptions {
  /** Today as YYYY-MM-DD; defaults to the device's local day. */
  today?: string
  /**
   * Pills act as links to the Notes tag filter: they get `role="button"`, a
   * tab stop, a pointer and a title. The caller handles the click (the pill
   * carries `data-note-tag`). Off by default: pills are then plain text.
   */
  tagLinks?: boolean
}

/** A source range to turn into a pill (`tag`) or drop from the text (`strip`). */
type Range =
  | { kind: 'tag'; start: number; end: number; key: string; display: string }
  | { kind: 'strip'; start: number; end: number }

interface TaskLine {
  done: boolean
  dueDate: string | null
  /** Source offset of the chosen due token's strip range. */
  dueStart: number | null
  strips: Range[]
}

// `leading-none` + `align-baseline`: a pill or chip never makes its line
// taller, a heading's included.
export const TAG_PILL_CLASS = [
  'note-tag',
  'inline-block',
  'rounded-full',
  'px-1.5',
  'py-px',
  'leading-none',
  'align-baseline',
  'text-[0.92em]',
  'text-[var(--color-accent)]',
  'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]'
]
const TAG_LINK_CLASS = ['cursor-pointer', 'hover:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]']

const CHIP_BASE = ['note-due', 'inline-block', 'ml-1.5', 'rounded-full', 'px-1.5', 'py-px', 'text-xs', 'leading-none', 'align-baseline', 'whitespace-nowrap']
const CHIP_TONE = {
  overdue: [
    'text-[var(--color-severity-warning-strong-text)]',
    'bg-[color-mix(in_srgb,var(--color-severity-warning)_18%,transparent)]'
  ],
  done: ['text-[var(--color-text-secondary)]', 'bg-[var(--color-bg-tertiary)]', 'line-through'],
  upcoming: ['text-[var(--color-text-secondary)]', 'bg-[var(--color-bg-tertiary)]']
}

/** Every tag range and task line in `source`, keyed by absolute offset / 0-based line. */
function scanSource(source: string): { tags: Range[]; tasks: Map<number, TaskLine> } {
  const lines = source.split('\n')
  const fenced = fencedLineMask(lines)
  const tags: Range[] = []
  const tasks = new Map<number, TaskLine>()
  let lineStart = 0
  lines.forEach((full, index) => {
    const at = lineStart
    lineStart += full.length + 1
    if (fenced[index]) return
    const line = full.replace(/\r$/, '')
    for (const t of findTagsInLine(line)) {
      tags.push({ kind: 'tag', start: at + t.start, end: at + t.end, key: t.key, display: t.display })
    }
    const m = TASK.exec(line)
    if (!m) return
    const itemAt = at + m[1].length + m[2].length + m[3].length
    const item = m[4]
    const strips: Range[] = []
    for (const token of item.matchAll(TOKEN)) {
      const start = (token.index ?? 0) + token[1].length
      strips.push({ kind: 'strip', start: itemAt + start, end: itemAt + (token.index ?? 0) + token[0].length })
    }
    const due = findDueTokens(item)[0]
    tasks.set(index, { done: m[2] !== ' ', dueDate: due?.date ?? null, dueStart: due ? itemAt + due.start : null, strips })
  })
  return { tags, tasks }
}

const ENTITY = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/

/** The characters a character reference stands for, or null for an unknown name. */
function decodeEntity(match: RegExpExecArray): string | null {
  const code = match[1] ? Number(match[1]) : match[2] ? parseInt(match[2], 16) : null
  if (code !== null) {
    try {
      return String.fromCodePoint(code === 0 ? 0xfffd : code)
    } catch {
      return null
    }
  }
  // A named reference: decoded by the browser, so its length is known.
  if (typeof document === 'undefined') return null
  const el = document.createElement('textarea')
  el.innerHTML = match[0]
  return el.value === match[0] ? null : el.value
}

/**
 * For each index of `node.value`, the source offset it came from, as far as
 * the value can be followed through the source (one past the end too, when it
 * all can). Follows backslash escapes, character references, and the line
 * structure remark drops from a paragraph's text: spaces before a soft break,
 * and indentation and `>` markers after it. Stops at the first character it
 * cannot place, so only the part before it is formatted.
 */
function offsetMap(node: MdNode, source: string): number[] {
  const value = node.value ?? ''
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (typeof start !== 'number' || typeof end !== 'number') return []
  const map: number[] = []
  if (source.slice(start, end) === value) {
    for (let i = 0; i <= value.length; i++) map.push(start + i)
    return map
  }
  let p = start
  let v = 0
  while (v < value.length) {
    if (p >= end) return map
    const ch = value[v]
    if (ch === '\n') {
      // Trailing whitespace before the line break is not in the value.
      while (p < end && (source[p] === ' ' || source[p] === '\t')) p++
      if (source[p] === '\r' && source[p + 1] === '\n') {
        map.push(p)
        p += 2
      } else if (source[p] === '\n' || source[p] === '\r') {
        map.push(p++)
      } else {
        return map
      }
      v++
      // Neither is the next line's indentation or blockquote marker.
      const next = value[v]
      while (p < end && (source[p] === ' ' || source[p] === '\t' || source[p] === '>') && source[p] !== next) p++
      continue
    }
    // A character reference first: `&amp;` starts with the `&` it stands for.
    const ref = source[p] === '&' ? ENTITY.exec(source.slice(p, end)) : null
    const decoded = ref ? decodeEntity(ref) : null
    if (ref && decoded && value.slice(v, v + decoded.length) === decoded) {
      for (let k = 0; k < decoded.length; k++) map.push(p)
      p += ref[0].length
      v += decoded.length
    } else if (source[p] === ch) {
      map.push(p++)
      v++
    } else if (source[p] === '\\' && source[p + 1] === ch) {
      map.push(p + 1)
      p += 2
      v++
    } else {
      return map
    }
  }
  map.push(p)
  return map
}

function textNode(value: string): MdNode {
  return { type: 'text', value }
}

function pillNode(display: string, key: string, links: boolean): MdNode {
  const hProperties: Record<string, unknown> = links
    ? { className: [...TAG_PILL_CLASS, ...TAG_LINK_CLASS], dataNoteTag: key, role: 'button', tabIndex: 0, title: `Show notes tagged #${display}` }
    : { className: TAG_PILL_CLASS, dataNoteTag: key }
  return { type: 'noteTag', children: [textNode(`#${display}`)], data: { hName: 'span', hProperties } }
}

/** "Today" reads "today" inside a sentence; a date stays as it is. */
function inSentence(label: string): string {
  return label === 'Today' || label === 'Tomorrow' || label === 'Yesterday' ? label.toLowerCase() : label
}

function chipNode(date: string, done: boolean, today: string): MdNode {
  const tone = done ? 'done' : date < today ? 'overdue' : 'upcoming'
  const label = formatDueLabel(date, today)
  // The tone is not colour alone: the title and accessible name say it.
  const title =
    tone === 'overdue' ? `Overdue · ${label}` : tone === 'done' ? `Done · due ${inSentence(label)}` : `Due ${inSentence(label)}`
  return {
    type: 'noteDue',
    children: [textNode(label)],
    data: {
      hName: 'span',
      hProperties: { className: [...CHIP_BASE, ...CHIP_TONE[tone]], dataNoteDue: date, dataTone: tone, title, ariaLabel: title }
    }
  }
}

/** `node` split around the ranges that fall wholly inside it, or null when none do. */
function splitText(node: MdNode, source: string, ranges: Range[], links: boolean, applied: Set<number>): MdNode[] | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (typeof start !== 'number' || typeof end !== 'number') return null
  const inside = ranges.filter((r) => r.start >= start && r.end <= end)
  if (inside.length === 0) return null
  const map = offsetMap(node, source)
  // The value index at source offset `at`: the first character placed at or
  // after it. A range's end may fall on text remark dropped (the spaces before
  // a soft break), so the next placed character ends it.
  const indexAt = (at: number, exact: boolean): number | undefined => {
    const v = map.findIndex((offset) => offset >= at)
    if (v < 0) return undefined
    return exact && map[v] !== at ? undefined : v
  }
  const value = node.value ?? ''
  const out: MdNode[] = []
  let cursor = 0
  for (const range of inside.sort((a, b) => a.start - b.start)) {
    const from = indexAt(range.start, true)
    const to = indexAt(range.end, false)
    if (from === undefined || to === undefined || from < cursor) continue
    if (from > cursor) out.push(textNode(value.slice(cursor, from)))
    if (range.kind === 'tag') out.push(pillNode(range.display, range.key, links))
    else applied.add(range.start)
    cursor = to
  }
  if (cursor === 0 && out.length === 0) return null
  if (cursor < value.length) out.push(textNode(value.slice(cursor)))
  return out
}

/** Leaves whose content is code or raw markup: never formatted. */
const LEAVES = new Set(['code', 'inlineCode', 'html', 'math', 'inlineMath'])

/**
 * Remark plugin: `#tag` pills and due chips in a note's read view. Use after
 * `remark-gfm` (task items need its `checked`).
 */
export function remarkNoteFormat(options: RemarkNoteFormatOptions = {}) {
  return (tree: MdNode, file: { value?: unknown }): void => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '')
    if (!source.includes('#') && !source.includes('[')) return
    const today = options.today ?? localDateKey()
    const { tags, tasks } = scanSource(source)

    // Task items as remark sees them: a line the parser reads as a task is
    // only formatted when it is also a GFM task item here, so a token is never
    // stripped without its chip being drawn.
    const items: Array<{ node: MdNode; task: TaskLine }> = []
    const collect = (node: MdNode): void => {
      if (node.type === 'listItem' && typeof node.checked === 'boolean') {
        const line = (node.position?.start.line ?? 0) - 1
        const task = tasks.get(line)
        if (task) items.push({ node, task })
      }
      for (const child of node.children ?? []) collect(child)
    }
    collect(tree)

    const links = options.tagLinks === true
    // Strip ranges actually taken out of the text, by source start.
    const applied = new Set<number>()
    const ranges: Range[] = [...tags, ...items.flatMap((i) => i.task.strips)]
    if (ranges.length > 0) {
      const rewrite = (node: MdNode): void => {
        if (!node.children || LEAVES.has(node.type)) return
        const next: MdNode[] = []
        for (const child of node.children) {
          if (child.type === 'text') {
            const split = splitText(child, source, ranges, links, applied)
            if (split) next.push(...split)
            else next.push(child)
          } else {
            rewrite(child)
            next.push(child)
          }
        }
        node.children = next
      }
      rewrite(tree)
    }

    for (const { node, task } of items) {
      // No chip unless its token left the text: a date never shows twice.
      if (!task.dueDate || task.dueStart === null || !applied.has(task.dueStart)) continue
      const chip = chipNode(task.dueDate, task.done, today)
      const children = node.children ?? (node.children = [])
      const paragraph = children.find((c) => c.type === 'paragraph')
      if (paragraph) (paragraph.children ?? (paragraph.children = [])).push(chip)
      else children.unshift(chip)
    }
  }
}
