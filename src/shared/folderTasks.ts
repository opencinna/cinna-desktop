/**
 * `.cinna/tasks/*.md` — a bare agent's task queue, kept as files in its own
 * folder so the agent, a script, a person or a teammate's `git pull` can edit
 * it, and Cinna indexes it.
 *
 * Pure: the parser, the status vocabulary, the board, and a **line-level
 * patcher**. Imported by the `folder` task adapter in main and by the renderer
 * (the board's types).
 *
 * ## The file
 *
 * Any `.md` with frontmatter directly under `.cinna/tasks/` (not `_board.yaml`,
 * not a dotfile, not a subdirectory). The folder is the marker: `cinna_task:`
 * missing means version 1, and `id:` missing means the filename stem — so
 * renaming an id-less file is a delete and a new task.
 *
 * Owned keys are {@link FOLDER_TASK_OWNED_KEYS}. Any other top-level key is a
 * custom field: a one-line value is editable, anything spanning lines (a nested
 * map, a block list, a block scalar) is shown as read-only text and **never
 * touched**. The body is the description; the handoff note lives in a section
 * the desktop owns at the end of it, between {@link HANDOFF_OPEN} and
 * {@link HANDOFF_CLOSE}. Before that section, a second desktop-owned section
 * between {@link LOG_OPEN} and {@link LOG_CLOSE} holds the task's comments as
 * an append-only export: it is not part of the description, and nothing in it
 * is ever read back.
 *
 * ## Why a patcher and not a serializer
 *
 * The reader is the frontmatter subset (`frontmatter.ts`), not YAML. Writing a
 * file back from what it read would drop every nested value it cannot
 * represent — a teammate's `meta:` block, a comment, a key order. So a write
 * replaces exactly the lines of the keys it owns (and one scalar custom key
 * when asked) and the handoff section, and every other byte stays where it was.
 */

import { isFrontmatterDelimiter, parseScalar, splitKey, stripComment, unquote } from './frontmatter'
import {
  TASK_CUSTOM_FIELD_KEY,
  TASK_CUSTOM_FIELDS_MAX,
  TASK_CUSTOM_FIELD_STRING_MAX,
  TASK_RESERVED_FIELD_KEYS,
  type TaskCustomFieldValue,
  type TaskCustomFields
} from './tasks'
import type { TaskStatus } from './taskStatus'

/** Relative to the agent folder. */
export const FOLDER_TASKS_DIR = '.cinna/tasks'

/** The folder's own status words, in board order. */
export const FOLDER_BOARD_FILE = '_board.yaml'

export const FOLDER_TASK_SCHEMA_VERSION = 1

export const HANDOFF_OPEN = '<!-- cinna:handoff -->'
export const HANDOFF_CLOSE = '<!-- /cinna:handoff -->'

/**
 * The comment log: Cinna appends one entry per comment (`task_comment`) and
 * never rewrites one. Export only — an edit made inside it is not read back
 * into the task's comments, and its text is never part of the description.
 */
export const LOG_OPEN = '<!-- cinna:log -->'
export const LOG_CLOSE = '<!-- /cinna:log -->'

/** The keys the desktop reads as task fields; nothing else is ever rewritten. */
export const FOLDER_TASK_OWNED_KEYS = [
  'cinna_task',
  'id',
  'title',
  'status',
  'priority',
  'parent',
  'blocked_by',
  'origin'
] as const

export type FolderTaskOwnedKey = (typeof FOLDER_TASK_OWNED_KEYS)[number]

function isOwnedKey(key: string): key is FolderTaskOwnedKey {
  return (FOLDER_TASK_OWNED_KEYS as readonly string[]).includes(key)
}

/** A task file's name: `*.md`, not a dotfile. `_board.yaml` is not `.md`. */
export function isFolderTaskFileName(name: string): boolean {
  return !name.startsWith('.') && name.toLowerCase().endsWith('.md') && name.length > 3
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * What a folder's word means to Cinna. Finer than `TaskStatusCategory` on the
 * closed end (done / failed / cancelled are three statuses there), and with
 * `hidden` for the filed-away pile.
 */
export type FolderStatusCategory =
  | 'backlog'
  | 'ready'
  | 'active'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'hidden'

export const FOLDER_STATUS_CATEGORIES: readonly FolderStatusCategory[] = [
  'backlog',
  'ready',
  'active',
  'waiting',
  'done',
  'failed',
  'cancelled',
  'hidden'
]

export function isFolderStatusCategory(value: unknown): value is FolderStatusCategory {
  return (FOLDER_STATUS_CATEGORIES as readonly unknown[]).includes(value)
}

/** The canonical status each category is stored as in `tasks.status`. */
export const FOLDER_CATEGORY_STATUS: Record<FolderStatusCategory, TaskStatus> = {
  backlog: 'new',
  ready: 'open',
  active: 'in_progress',
  waiting: 'blocked',
  done: 'completed',
  failed: 'error',
  cancelled: 'cancelled',
  hidden: 'archived'
}

/** The words every folder understands without a `_board.yaml`, normalized. */
export const DEFAULT_FOLDER_STATUS_WORDS: Record<FolderStatusCategory, readonly string[]> = {
  backlog: ['new', 'refining', 'backlog', 'todo'],
  ready: ['open', 'ready', 'next'],
  active: ['in_progress', 'doing', 'wip'],
  waiting: ['blocked', 'waiting', 'review'],
  done: ['done', 'completed', 'closed'],
  failed: ['error', 'failed'],
  cancelled: ['cancelled', 'canceled', 'wontfix'],
  hidden: ['archived']
}

/** The category a desktop status belongs to, in the folder's vocabulary. */
export function folderCategoryForStatus(status: TaskStatus): FolderStatusCategory {
  switch (status) {
    case 'new':
    case 'refining':
      return 'backlog'
    case 'open':
      return 'ready'
    case 'in_progress':
      return 'active'
    case 'blocked':
      return 'waiting'
    case 'completed':
      return 'done'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'archived':
      return 'hidden'
  }
}

/**
 * The statuses a person may drop a card on — the board's user columns plus
 * `cancelled`, which `canMoveManually` also allows. Active and Waiting are a
 * run's and a question's, never a drag's; failed and hidden are not a person's
 * move either.
 */
const DROPPABLE_STATUSES: readonly TaskStatus[] = ['new', 'open', 'completed', 'cancelled']

/** Lowercase, trimmed, runs of space or hyphen as `_`: `In Progress` is `in_progress`. */
export function normalizeStatusWord(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** One `word: category` line of `_board.yaml`, in file order. */
export interface FolderBoardEntry {
  /** Normalized. */
  word: string
  /** As written in `_board.yaml` — what a column says and what a write writes. */
  label: string
  category: FolderStatusCategory
}

export interface FolderBoard {
  entries: FolderBoardEntry[]
}

export const EMPTY_FOLDER_BOARD: FolderBoard = { entries: [] }

/**
 * `_board.yaml`: flat `word: category` lines, in board order. A comment, a
 * blank line, an indented line or an unknown category is skipped rather than
 * refused — the file is a person's, and one typo must not take the board down.
 * A word named twice keeps its first line.
 */
export function parseFolderBoard(text: string): FolderBoard {
  const entries: FolderBoardEntry[] = []
  const seen = new Set<string>()
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#') || /^\s/.test(raw)) continue
    const parsed = boardLine(raw)
    if (!parsed) continue
    const word = normalizeStatusWord(parsed.label)
    if (!word || seen.has(word)) continue
    seen.add(word)
    entries.push({ word, label: parsed.label, category: parsed.category })
  }
  return { entries }
}

/** `In Progress: active`, `"on hold": waiting`. The key may hold spaces, unlike a frontmatter key. */
function boardLine(raw: string): { label: string; category: FolderStatusCategory } | null {
  const quoted = /^("[^"]*"|'[^']*')\s*:\s*(.*)$/.exec(raw)
  const match = quoted ?? /^([^:#]+?)\s*:\s*(.*)$/.exec(raw)
  if (!match) return null
  const label = (quoted ? (unquote(match[1]) ?? '') : match[1]).trim()
  const value = parseScalar(match[2])
  const category = typeof value === 'string' ? value.trim().toLowerCase() : null
  if (!label || !isFolderStatusCategory(category)) return null
  return { label, category }
}

/**
 * What a word means in this folder: `_board.yaml` first, then the defaults.
 * Null for a word neither knows — shown as written, stored as `new`, inert.
 */
export function folderCategoryOf(word: string, board: FolderBoard): FolderStatusCategory | null {
  const normalized = normalizeStatusWord(word)
  if (!normalized) return null
  const entry = board.entries.find((candidate) => candidate.word === normalized)
  if (entry) return entry.category
  for (const category of FOLDER_STATUS_CATEGORIES) {
    if (DEFAULT_FOLDER_STATUS_WORDS[category].includes(normalized)) return category
  }
  return null
}

/**
 * The stored status for a file's word. A missing word is a fresh task
 * (backlog); an unmapped one is `new` with no category, so nothing reacts to it.
 */
export function folderStatusOf(
  word: string | null,
  board: FolderBoard
): { status: TaskStatus; category: FolderStatusCategory | null } {
  if (word === null || normalizeStatusWord(word) === '') return { status: 'new', category: 'backlog' }
  const category = folderCategoryOf(word, board)
  return category ? { status: FOLDER_CATEGORY_STATUS[category], category } : { status: 'new', category: null }
}

/** Does `label` mean `status` in this folder? The check `task:set-status`'s label is held to. */
export function folderLabelMapsTo(label: string, status: TaskStatus, board: FolderBoard): boolean {
  const category = folderCategoryOf(label, board)
  return category !== null && FOLDER_CATEGORY_STATUS[category] === status
}

/** One column of a folder's board, left to right. */
export interface TaskBoardColumn {
  /** The word as the folder writes it. Also what a drop sends as `label`. */
  label: string
  /** Null for a word the folder uses that nothing maps. */
  category: FolderStatusCategory | null
  /** The stored status a card in this column has. */
  status: TaskStatus
  /** A person may drop a card here (phase-1 drop rules; never Active or Waiting). */
  droppable: boolean
}

/** The word written for a category when the folder offers none of its own. */
const CANONICAL_WORD: Record<FolderStatusCategory, string> = {
  backlog: 'new',
  ready: 'open',
  active: 'in_progress',
  waiting: 'blocked',
  done: 'completed',
  failed: 'error',
  cancelled: 'cancelled',
  hidden: 'archived'
}

/**
 * The folder board, in lifecycle order: backlog, ready, active, waiting, done,
 * failed, cancelled, hidden. Within a category, its `_board.yaml` words in file
 * order, then the default words the folder's files actually use (the default
 * table's order); the unmapped words in use come last (alphabetically). `inUse`
 * is the words as written in the files; the first spelling of a word is its
 * label.
 *
 * `occupied` is the categories some task shown on this board sits in — a file
 * task, but also a native, handover or delegation task assigned to the agent.
 * A category in it with no column of its own gets one, labelled with the
 * canonical word (`in_progress`, `completed`, …), so no card falls into a
 * column of another category.
 */
export function folderBoardColumns(
  board: FolderBoard,
  inUse: readonly string[],
  occupied: readonly FolderStatusCategory[] = []
): TaskBoardColumn[] {
  const spelling = new Map<string, string>()
  for (const raw of inUse) {
    const word = normalizeStatusWord(raw)
    if (word && !spelling.has(word)) spelling.set(word, raw.trim())
  }
  const columns: TaskBoardColumn[] = []
  const placed = new Set<string>()
  const add = (word: string, label: string, category: FolderStatusCategory | null): void => {
    placed.add(word)
    const status = category ? FOLDER_CATEGORY_STATUS[category] : 'new'
    columns.push({ label, category, status, droppable: category !== null && DROPPABLE_STATUSES.includes(status) })
  }
  for (const category of FOLDER_STATUS_CATEGORIES) {
    const before = columns.length
    for (const entry of board.entries) {
      if (entry.category === category) add(entry.word, entry.label, entry.category)
    }
    for (const word of DEFAULT_FOLDER_STATUS_WORDS[category]) {
      if (placed.has(word) || !spelling.has(word) || folderCategoryOf(word, board) !== category) continue
      add(word, spelling.get(word) as string, category)
    }
    if (columns.length === before && occupied.includes(category) && !placed.has(CANONICAL_WORD[category])) {
      add(CANONICAL_WORD[category], CANONICAL_WORD[category], category)
    }
  }
  const unmapped = [...spelling.keys()].filter((word) => !placed.has(word)).sort()
  for (const word of unmapped) add(word, spelling.get(word) as string, folderCategoryOf(word, board))
  return columns
}

/**
 * The word Cinna writes for a status: **null (leave the file alone)** when the
 * current word already maps to it, else the folder's first word for that
 * category in board order, else the canonical word.
 */
export function folderWordForStatus(
  status: TaskStatus,
  current: string | null,
  board: FolderBoard,
  inUse: readonly string[]
): string | null {
  const category = folderCategoryForStatus(status)
  if (current !== null && normalizeStatusWord(current) !== '' && folderCategoryOf(current, board) === category) {
    return null
  }
  const column = folderBoardColumns(board, inUse).find((candidate) => candidate.category === category)
  return column ? column.label : CANONICAL_WORD[category]
}

// ---------------------------------------------------------------------------
// The file, as lines
// ---------------------------------------------------------------------------

/** One physical line and the terminator it had, so a rewrite can keep both. */
interface Line {
  text: string
  /** `\n`, `\r\n`, or `''` for a last line with none. */
  eol: string
}

interface Document {
  bom: string
  lines: Line[]
  /** Index of the closing `---`; the opening one is line 0. */
  close: number
  /** The terminator this file mostly uses, for lines the patcher adds. */
  eol: string
}

function toLines(text: string): Line[] {
  const lines: Line[] = []
  const pattern = /\r\n|\n/g
  let start = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] })
    start = match.index + match[0].length
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' })
  return lines
}

function toDocument(text: string): Document | null {
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const lines = toLines(bom ? text.slice(1) : text)
  if (lines.length === 0 || !isFrontmatterDelimiter(lines[0].text)) return null
  const close = lines.findIndex((line, index) => index > 0 && isFrontmatterDelimiter(line.text))
  if (close === -1) return null
  const crlf = lines.filter((line) => line.eol === '\r\n').length
  const lf = lines.filter((line) => line.eol === '\n').length
  return { bom, lines, close, eol: crlf > lf ? '\r\n' : '\n' }
}

function fromDocument(doc: Document): string {
  return doc.bom + doc.lines.map((line) => line.text + line.eol).join('')
}

/** A top-level key and the lines it spans, `[start, end)`. */
interface Entry {
  key: string
  start: number
  end: number
  /** The text after `key:` on its own line. */
  rest: string
  /** Spans more than one line, or opens a block/flow map on its line. */
  nested: boolean
}

function isContinuation(text: string): boolean {
  return /^\s/.test(text) || text.startsWith('-')
}

/**
 * The frontmatter's top-level keys. A key's value continues over the lines
 * that are indented or start with `-`; a blank line belongs to it only when
 * more of it follows. A comment or a stray line at column 0 belongs to nothing.
 */
function entriesOf(doc: Document): Entry[] {
  const entries: Entry[] = []
  for (let index = 1; index < doc.close; index += 1) {
    const text = doc.lines[index].text
    if (text.trim() === '' || text.trimStart().startsWith('#') || /^\s/.test(text)) continue
    const pair = splitKey(text.trim())
    if (!pair) continue
    let end = index + 1
    let probe = end
    while (probe < doc.close) {
      const next = doc.lines[probe].text
      if (next.trim() === '') {
        probe += 1
        continue
      }
      if (!isContinuation(next)) break
      probe += 1
      end = probe
    }
    const rest = pair.rest
    // A flow map (`{a: 1}`) is structure this reader does not model, so it is
    // somebody else's even on one line; an unclosed `[` continues elsewhere.
    const opensBlock = /^[|>]/.test(rest) || rest.startsWith('{') || (rest.startsWith('[') && !rest.endsWith(']'))
    entries.push({ key: pair.key, start: index, end, rest, nested: end > index + 1 || opensBlock })
    index = end - 1
  }
  return entries
}

/** The last entry for a key — what a reader that lets a later line win sees. */
function lastEntry(entries: Entry[], key: string): Entry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].key === key) return entries[i]
  return undefined
}

/** A one-line scalar as text, or null. Numbers stringify: an id may be digits. */
function textOf(entry: Entry | undefined): string | null {
  if (!entry || entry.nested) return null
  const value = parseScalar(entry.rest)
  if (value === null) return null
  const text = typeof value === 'number' ? String(value) : value.trim()
  return text === '' ? null : text
}

/** `[a, "b, c"]` split on commas outside quotes. */
function flowItems(rest: string): string[] {
  const inner = rest.slice(1, -1)
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of inner) {
    if (quote) {
      current += char
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === ',') {
      items.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '' || items.length > 0) items.push(current)
  return items.map((item) => item.trim()).filter((item) => item !== '')
}

/** A custom field's one-line value: quoted text, `true`/`false`, a number, null, or bare text. */
function customScalar(raw: string): string | number | boolean | null {
  const trimmed = raw.trim()
  const quoted = unquote(trimmed)
  if (quoted !== null) return quoted
  const value = stripComment(trimmed)
  if (value === '' || value === '~' || value === 'null') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^[-+]?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

/** The lines of a nested value, dedented, with the inline part (`|`, `{`) first. */
function nestedText(doc: Document, entry: Entry): string {
  const body = doc.lines.slice(entry.start + 1, entry.end).map((line) => line.text)
  const indents = body.filter((text) => text.trim() !== '').map((text) => text.length - text.trimStart().length)
  const cut = indents.length > 0 ? Math.min(...indents) : 0
  const lines = body.map((text) => text.slice(Math.min(cut, text.length - text.trimStart().length)))
  return [entry.rest, ...lines].filter((line, index) => index > 0 || line !== '').join('\n').trimEnd()
}

/** One custom field as the file holds it. */
export interface FolderTaskCustomField {
  key: string
  /** Read-only text for a nested or over-long value. */
  value: TaskCustomFieldValue
  /** One line the patcher may rewrite. False: shown, never touched. */
  editable: boolean
}

/** A task file, read. */
export interface ParsedFolderTask {
  /** `cinna_task:` as a number, or null when absent (= version 1). */
  version: number | null
  /** `id:`, or the filename stem when the file has none. */
  id: string
  idFromFile: boolean
  title: string | null
  /** The status word as written, trimmed, or null. */
  status: string | null
  priority: string | null
  parent: string | null
  blockedBy: string[]
  origin: string | null
  custom: FolderTaskCustomField[]
  /** The body before the handoff section, trimmed; null when empty. */
  description: string | null
  /** The handoff section's content, trimmed; null when there is none. */
  handoffNote: string | null
}

/**
 * The body as lines after the closing `---`, split at the handoff section:
 * `head` before the opening marker, `section` from the opening marker through
 * the closing one, and `tail` — the user's own text after the closing marker,
 * which is not the section's and which a handoff write keeps byte for byte.
 */
function bodyParts(doc: Document): { head: Line[]; section: Line[]; tail: Line[] } {
  const body = doc.lines.slice(doc.close + 1)
  // The section is the **last** closing marker and the opening marker nearest
  // before it — the pair a write appends at the end. A stray opening marker
  // earlier in the body (a quoted marker, a half-deleted section) is the
  // user's text: paired with our closing marker instead, the second handoff
  // write would replace everything between the two and delete it from disk.
  let closeAt = -1
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i].text.trim() === HANDOFF_CLOSE) { closeAt = i; break }
  }
  let open = -1
  for (let i = closeAt - 1; i >= 0; i -= 1) {
    if (body[i].text.trim() === HANDOFF_OPEN) { open = i; break }
  }
  if (closeAt === -1 || open === -1) return { head: body, section: [], tail: [] }
  return { head: body.slice(0, open), section: body.slice(open, closeAt + 1), tail: body.slice(closeAt + 1) }
}

/**
 * The text before the handoff section, split at the comment log: `before` it,
 * the `log` itself (both markers included) and the user's text `after` it.
 * The log is the **last** closing marker and the opening marker nearest before
 * it, for the same reason as the handoff section's pairing.
 */
function logParts(head: Line[]): { before: Line[]; log: Line[]; after: Line[] } {
  let closeAt = -1
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (head[i].text.trim() === LOG_CLOSE) { closeAt = i; break }
  }
  let open = -1
  for (let i = closeAt - 1; i >= 0; i -= 1) {
    if (head[i].text.trim() === LOG_OPEN) { open = i; break }
  }
  if (closeAt === -1 || open === -1) return { before: head, log: [], after: [] }
  return { before: head.slice(0, open), log: head.slice(open, closeAt + 1), after: head.slice(closeAt + 1) }
}

function joined(lines: Line[]): string {
  return lines.map((line) => line.text).join('\n').trim()
}

/**
 * Read a task file. Null when it has no frontmatter — it is then not a task,
 * whatever folder it is in.
 */
export function parseFolderTaskFile(text: string, stem: string): ParsedFolderTask | null {
  const doc = toDocument(text)
  if (!doc) return null
  const entries = entriesOf(doc)
  const versionRaw = textOf(lastEntry(entries, 'cinna_task'))
  const version = versionRaw === null ? null : Number(versionRaw)
  const fileId = textOf(lastEntry(entries, 'id'))

  const blocked = lastEntry(entries, 'blocked_by')
  let blockedBy: string[] = []
  if (blocked && !blocked.nested && blocked.rest.startsWith('[') && blocked.rest.endsWith(']')) {
    blockedBy = flowItems(blocked.rest).map((item) => String(parseScalar(item) ?? '')).filter(Boolean)
  } else if (blocked?.nested) {
    blockedBy = doc.lines
      .slice(blocked.start + 1, blocked.end)
      .map((line) => line.text.trim())
      .filter((item) => item.startsWith('-'))
      .map((item) => String(parseScalar(item.slice(1)) ?? ''))
      .filter(Boolean)
  } else {
    const single = textOf(blocked)
    if (single) blockedBy = [single]
  }

  const custom: FolderTaskCustomField[] = []
  const customSeen = new Set<string>()
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (isOwnedKey(entry.key) || customSeen.has(entry.key)) continue
    customSeen.add(entry.key)
    // A key the app's custom-field validator would refuse is left in the file
    // and out of the task: showing it would make every later edit of the
    // task's fields fail on a key the user did not touch.
    if (!TASK_CUSTOM_FIELD_KEY.test(entry.key) || TASK_RESERVED_FIELD_KEYS.includes(entry.key)) continue
    if (entry.nested) {
      custom.unshift({ key: entry.key, value: clip(nestedText(doc, entry)), editable: false })
      continue
    }
    if (entry.rest.startsWith('[') && entry.rest.endsWith(']')) {
      const items = flowItems(entry.rest).map(customScalar)
      if (items.every((item): item is string | number | boolean => item !== null)) {
        const long = items.some((item) => typeof item === 'string' && item.length > TASK_CUSTOM_FIELD_STRING_MAX)
        custom.unshift(long
          ? { key: entry.key, value: clip(entry.rest), editable: false }
          : { key: entry.key, value: items, editable: true })
        continue
      }
      custom.unshift({ key: entry.key, value: clip(entry.rest), editable: false })
      continue
    }
    const value = customScalar(entry.rest)
    if (typeof value === 'string' && value.length > TASK_CUSTOM_FIELD_STRING_MAX) {
      custom.unshift({ key: entry.key, value: clip(value), editable: false })
    } else {
      custom.unshift({ key: entry.key, value, editable: true })
    }
  }

  const { head, section, tail } = bodyParts(doc)
  // Text after the section is the user's description too, read as one with
  // the text before it. The comment log is not: it is Cinna's export.
  const { before, after } = logParts(head)
  const description = [joined(before), joined(after), joined(tail)].filter((part) => part !== '').join('\n\n')
  const note = section.length === 0 ? '' : joined(section.slice(1, -1))

  return {
    version: version !== null && Number.isFinite(version) ? version : null,
    id: fileId ?? stem,
    idFromFile: fileId !== null,
    title: textOf(lastEntry(entries, 'title')),
    status: textOf(lastEntry(entries, 'status')),
    priority: textOf(lastEntry(entries, 'priority')),
    parent: textOf(lastEntry(entries, 'parent')),
    blockedBy,
    origin: textOf(lastEntry(entries, 'origin')),
    custom: custom.slice(0, TASK_CUSTOM_FIELDS_MAX),
    description: description === '' ? null : description,
    handoffNote: note === '' ? null : note
  }
}

function clip(text: string): string {
  return text.length > TASK_CUSTOM_FIELD_STRING_MAX ? `${text.slice(0, TASK_CUSTOM_FIELD_STRING_MAX - 1)}…` : text
}

/** The custom fields as a task stores them; null when there are none. */
export function folderCustomFields(parsed: ParsedFolderTask): TaskCustomFields | null {
  if (parsed.custom.length === 0) return null
  const fields: TaskCustomFields = {}
  for (const field of parsed.custom) fields[field.key] = field.value
  return fields
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A word that reads back as itself without quotes. */
const BARE = /^[A-Za-z_][A-Za-z0-9 _./()+-]*$/

/** A value as one frontmatter token that {@link parseScalar} / the custom reader read back. */
export function formatFolderValue(value: string | number | boolean): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = value.replace(/[\r\n]+/g, ' ')
  const plain = BARE.test(text) && text === text.trim() && !/\s#/.test(text) &&
    !['null', 'true', 'false', '~'].includes(text.toLowerCase())
  if (plain) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function formatCustom(value: TaskCustomFieldValue): string {
  if (value === null) return ''
  if (Array.isArray(value)) return `[${value.map((item) => formatFolderValue(item)).join(', ')}]`
  return formatFolderValue(value as string | number | boolean)
}

function keyLine(key: string, token: string): string {
  return token === '' ? `${key}:` : `${key}: ${token}`
}

/**
 * What a write changes. `undefined` leaves a key alone; `null` removes an owned
 * key's line (or, for `description` / `handoffNote`, empties that part).
 * `custom` maps a key to its new value, or to `undefined` to remove it — only
 * a one-line custom key is ever touched; a nested one is left as it is.
 */
export interface FolderTaskPatch {
  cinnaTask?: number
  id?: string
  title?: string
  status?: string
  priority?: string | null
  parent?: string | null
  origin?: string | null
  description?: string | null
  handoffNote?: string | null
  custom?: Record<string, TaskCustomFieldValue | undefined>
  /**
   * One entry appended to the comment log (made by {@link formatFolderLogEntry}),
   * creating the log before the handoff section when the file has none. Every
   * other byte — earlier entries included — stays as it was.
   */
  appendLog?: string
}

/**
 * Rewrite only what the patch names. Throws when the text has no frontmatter —
 * a caller patching a file it could not parse has a bug.
 */
export function patchFolderTaskFile(text: string, patch: FolderTaskPatch): string {
  const doc = toDocument(text)
  if (!doc) throw new Error('This file has no frontmatter to patch.')

  const scalarSets: [string, string | null | undefined][] = [
    ['cinna_task', patch.cinnaTask === undefined ? undefined : String(patch.cinnaTask)],
    ['id', patch.id === undefined ? undefined : formatFolderValue(patch.id)],
    ['title', patch.title === undefined ? undefined : formatFolderValue(patch.title)],
    ['status', patch.status === undefined ? undefined : formatFolderValue(patch.status)],
    ['priority', patch.priority === undefined ? undefined : patch.priority === null ? null : formatFolderValue(patch.priority)],
    ['parent', patch.parent === undefined ? undefined : patch.parent === null ? null : formatFolderValue(patch.parent)],
    ['origin', patch.origin === undefined ? undefined : patch.origin === null ? null : formatFolderValue(patch.origin)]
  ]
  for (const [key, token] of scalarSets) {
    if (token === undefined) continue
    setKey(doc, key, token, true)
  }
  for (const [key, value] of Object.entries(patch.custom ?? {})) {
    if (isOwnedKey(key) || !TASK_CUSTOM_FIELD_KEY.test(key)) continue
    setKey(doc, key, value === undefined ? null : formatCustom(value), false)
  }

  if (patch.description !== undefined) setDescription(doc, patch.description)
  if (patch.handoffNote !== undefined) setHandoff(doc, patch.handoffNote)
  if (patch.appendLog !== undefined) appendLog(doc, patch.appendLog)
  return fromDocument(doc)
}

/**
 * Point one key at a new one-line value, remove it (`null`), or add it before
 * the closing `---`. An owned key is ours whatever shape it had; a custom key
 * spanning lines is somebody else's structure and is left alone.
 */
function setKey(doc: Document, key: string, token: string | null, owned: boolean): void {
  const entries = entriesOf(doc)
  const entry = lastEntry(entries, key)
  if (entry && entry.nested && !owned) return
  if (entry) {
    const eol = doc.lines[entry.end - 1].eol || doc.eol
    const replacement: Line[] = token === null ? [] : [{ text: keyLine(key, token), eol }]
    doc.lines.splice(entry.start, entry.end - entry.start, ...replacement)
    doc.close += replacement.length - (entry.end - entry.start)
    return
  }
  if (token === null) return
  doc.lines.splice(doc.close, 0, { text: keyLine(key, token), eol: doc.eol })
  doc.close += 1
}

function textLines(text: string, eol: string): Line[] {
  return text.split(/\r?\n/).map((line) => ({ text: line, eol }))
}

/**
 * Replace the description — the body around the handoff section, so text the
 * user had after the section is part of what is replaced — and keep the
 * section byte for byte, now at the end.
 */
function setDescription(doc: Document, description: string | null): void {
  const { head, section } = bodyParts(doc)
  const { log } = logParts(head)
  const text = description?.trim() ?? ''
  // The description, then the comment log and the handoff section byte for
  // byte, one blank line between each.
  const blocks = [text !== '' ? textLines(text, doc.eol) : [], log, section].filter((block) => block.length > 0)
  const body: Line[] = []
  blocks.forEach((block, index) => {
    if (index > 0) body.push({ text: '', eol: doc.eol })
    body.push(...block)
  })
  ensureCloseTerminated(doc)
  doc.lines.splice(doc.close + 1, doc.lines.length - doc.close - 1, ...body)
}

/**
 * Append one entry to the comment log, inside its closing marker. A file with
 * no log gets one at the end of the text before the handoff section (after
 * the description, before any blank lines that separate it from the section).
 * Only lines are added: every byte already in the file stays where it was.
 */
function appendLog(doc: Document, entry: string): void {
  const { head, section, tail } = bodyParts(doc)
  const { before, log, after } = logParts(head)
  const blank = (): Line => ({ text: '', eol: doc.eol })
  const entryLines = textLines(entry.trim(), doc.eol)
  ensureCloseTerminated(doc)
  let next: Line[]
  if (log.length > 0) {
    const inner = log.slice(0, -1)
    const close = log[log.length - 1]
    if (inner[inner.length - 1].eol === '') inner[inner.length - 1] = { ...inner[inner.length - 1], eol: doc.eol }
    next = [...before, ...inner, ...(inner.length > 1 ? [blank()] : []), ...entryLines, close, ...after]
  } else {
    let cut = head.length
    while (cut > 0 && head[cut - 1].text.trim() === '') cut -= 1
    const content = head.slice(0, cut)
    const trailing = head.slice(cut)
    if (content.length > 0 && content[content.length - 1].eol === '') {
      content[content.length - 1] = { ...content[content.length - 1], eol: doc.eol }
    }
    const block: Line[] = [{ text: LOG_OPEN, eol: doc.eol }, ...entryLines, { text: LOG_CLOSE, eol: doc.eol }]
    const separator = trailing.length > 0 ? trailing : section.length > 0 ? [blank()] : []
    next = [...content, ...(content.length > 0 ? [blank()] : []), ...block, ...separator]
  }
  doc.lines.splice(doc.close + 1, doc.lines.length - doc.close - 1, ...next, ...section, ...tail)
}

/**
 * One comment-log entry: who and when on the first line, then the body. A
 * body line that would read as one of the section markers is defused, so a
 * comment can never close the log (or the handoff section) early.
 */
export function formatFolderLogEntry(entry: { author: string; at: Date; body: string }): string {
  const author = entry.author.replace(/[\r\n]+/g, ' ').trim() || 'Agent'
  const at = entry.at.toISOString().slice(0, 16).replace('T', ' ')
  const body = entry.body.replace(/<!--/g, '&lt;!--').trim()
  return `**${author}** · ${at} UTC\n${body}`
}

/**
 * Replace, add or remove the handoff section in place; the description — the
 * text before the section and the user's text after it — stays byte for byte.
 */
function setHandoff(doc: Document, note: string | null): void {
  const { head, section: current, tail } = bodyParts(doc)
  const kept = [...head]
  const text = note?.trim() ?? ''
  const tailBlank = tail.every((line) => line.text.trim() === '')
  if (text === '') {
    // Removing the section: drop the blank lines that only separated it —
    // unless the user's text follows it, which they still separate.
    if (tailBlank) while (kept.length > 0 && kept[kept.length - 1].text.trim() === '') kept.pop()
  } else if (kept.length > 0 && kept[kept.length - 1].text.trim() !== '') {
    kept.push({ text: '', eol: doc.eol })
  }
  if (kept.length > 0 && kept[kept.length - 1].eol === '') kept[kept.length - 1] = { ...kept[kept.length - 1], eol: doc.eol }
  const section: Line[] = text === ''
    ? []
    : [{ text: HANDOFF_OPEN, eol: doc.eol }, ...textLines(text, doc.eol), { text: HANDOFF_CLOSE, eol: doc.eol }]
  // A section the user's text follows ends the way the old one did, so the
  // tail starts where it started.
  if (section.length > 0 && current.length > 0 && tail.length > 0) {
    section[section.length - 1] = { ...section[section.length - 1], eol: current[current.length - 1].eol || doc.eol }
  }
  // With no section left, the tail stays only when it holds text.
  const after = text === '' && tailBlank ? [] : tail
  ensureCloseTerminated(doc)
  doc.lines.splice(doc.close + 1, doc.lines.length - doc.close - 1, ...kept, ...section, ...after)
}

/** A file ending in `---` with no newline gets one before a body follows it. */
function ensureCloseTerminated(doc: Document): void {
  if (doc.lines[doc.close].eol === '') doc.lines[doc.close] = { ...doc.lines[doc.close], eol: doc.eol }
}

/** What a desktop-created file says, in the fixed key order. */
export interface FolderTaskFileInput {
  id: string
  title: string
  status: string
  priority: string
  parent?: string | null
  origin?: string | null
  custom?: TaskCustomFields | null
  description?: string | null
  handoffNote?: string | null
}

/** A new task file: `cinna_task, id, title, status, priority, parent, origin`, then custom fields. */
export function renderFolderTaskFile(input: FolderTaskFileInput): string {
  const lines = [
    '---',
    `cinna_task: ${FOLDER_TASK_SCHEMA_VERSION}`,
    keyLine('id', formatFolderValue(input.id)),
    keyLine('title', formatFolderValue(input.title)),
    keyLine('status', formatFolderValue(input.status)),
    keyLine('priority', formatFolderValue(input.priority)),
    ...(input.parent ? [keyLine('parent', formatFolderValue(input.parent))] : []),
    ...(input.origin ? [keyLine('origin', formatFolderValue(input.origin))] : [])
  ]
  for (const [key, value] of Object.entries(input.custom ?? {})) {
    if (isOwnedKey(key) || !TASK_CUSTOM_FIELD_KEY.test(key)) continue
    lines.push(keyLine(key, formatCustom(value)))
  }
  lines.push('---')
  const description = input.description?.trim() ?? ''
  if (description) lines.push(description)
  const note = input.handoffNote?.trim() ?? ''
  if (note) {
    if (description) lines.push('')
    lines.push(HANDOFF_OPEN, note, HANDOFF_CLOSE)
  }
  return `${lines.join('\n')}\n`
}

/** `Fix the login bug!` → `fix-the-login-bug`. Never empty. */
export function folderTaskSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug || 'task'
}

/** `<slug>.md`, then `<slug>-2.md`, `<slug>-3.md` on a collision. */
export function folderTaskFileName(slug: string, attempt: number): string {
  return attempt <= 1 ? `${slug}.md` : `${slug}-${attempt}.md`
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** `t-` and eight base32 characters from the given random bytes. */
export function folderTaskId(bytes: Uint8Array): string {
  let id = 't-'
  for (let i = 0; i < 8; i += 1) id += BASE32[(bytes[i] ?? 0) % 32]
  return id
}
