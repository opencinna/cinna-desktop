// What the Notes surfaces derive from a note's body, in memory: whether it is
// an Assistant memory note, its tags (frontmatter `tags` + inline `#tags`),
// and the tag filter's chips. `tagFilterChips` / `noteIdsForTag` are ports of
// the mobile app's `src/notes/noteIndex.ts`. Nothing here is persisted.

import { splitFrontmatter, type FrontmatterEntry } from '../frontmatter'
import { extractTags, isValidTag, tagKey, tagMatchesFilter, type NoteTag } from './tags'

/** The frontmatter `kind` value Cinna Assistant writes on its memory notes. */
export const MEMORY_KIND = 'assistant-memory'

function entry(entries: FrontmatterEntry[], key: string): FrontmatterEntry | undefined {
  return entries.find((e) => e.key === key)
}

function textValue(e: FrontmatterEntry | undefined): string | null {
  return e && e.value.kind === 'text' ? e.value.text.trim() : null
}

/** Whether a note is an Assistant memory note: its frontmatter says
 *  `kind: assistant-memory`. Identity comes from `kind` only, never a folder. */
export function isMemoryNote(body: string): boolean {
  const { frontmatter } = splitFrontmatter(body)
  return !!frontmatter && textValue(entry(frontmatter.entries, 'kind')) === MEMORY_KIND
}

export interface MemoryInfo {
  /** Frontmatter `memory_type` (or `type`), when set. */
  memoryType: string | null
  /** Frontmatter `summary` (or `description`), when set. */
  summary: string | null
}

/** A memory note's own description of itself, or null for any other note. */
export function memoryInfo(body: string): MemoryInfo | null {
  const { frontmatter } = splitFrontmatter(body)
  if (!frontmatter || textValue(entry(frontmatter.entries, 'kind')) !== MEMORY_KIND) return null
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = textValue(entry(frontmatter.entries, key))
      if (value) return value
    }
    return null
  }
  return { memoryType: pick('memory_type', 'type'), summary: pick('summary', 'description') }
}

/** Frontmatter `tags` items as tag bodies: `#` dropped, trailing `/` dropped,
 *  invalid ones skipped. A text scalar splits on commas and whitespace. */
function frontmatterTags(e: FrontmatterEntry | undefined): string[] {
  if (!e) return []
  const raw = e.value.kind === 'list' ? e.value.items : e.value.kind === 'text' ? e.value.text.split(/[\s,]+/) : []
  return raw
    .map((item) => item.trim().replace(/^#+/, '').replace(/\/+$/, ''))
    .filter((item) => item !== '' && isValidTag(item))
}

/** A note's tags: frontmatter `tags` first (read-only), then inline `#tags`
 *  in the body below the frontmatter; one per key, first-seen casing. */
export function noteTags(body: string): NoteTag[] {
  const split = splitFrontmatter(body)
  const seen = new Map<string, NoteTag>()
  const add = (display: string): void => {
    const key = tagKey(display)
    if (!seen.has(key)) seen.set(key, { key, display })
  }
  if (split.frontmatter) for (const display of frontmatterTags(entry(split.frontmatter.entries, 'tags'))) add(display)
  for (const t of extractTags(split.body)) add(t.display)
  return [...seen.values()]
}

/** Notes split into the regular ones and Assistant memory notes, each in the
 *  order given. */
export function splitNotes<T extends { body: string }>(notes: readonly T[]): { regular: T[]; memory: T[] } {
  const regular: T[] = []
  const memory: T[] = []
  for (const note of notes) (isMemoryNote(note.body) ? memory : regular).push(note)
  return { regular, memory }
}

/** One note-tag pair. */
export interface NoteTagRow {
  noteId: string
  key: string
  display: string
}

/** A filter chip: a tag (or a parent of nested tags) and how many notes it matches. */
export interface TagChip {
  key: string
  display: string
  count: number
}

/**
 * Filter chips for the Notes list: every tag plus every parent of a nested tag
 * (`#inbox/to-read` also offers `inbox`), each counting the distinct notes it
 * matches, sorted by display name. A parent's display comes from its own tag
 * when one exists, else from the first nested tag's prefix.
 */
export function tagFilterChips(rows: readonly NoteTagRow[]): TagChip[] {
  const chips = new Map<string, { display: string; own: boolean; notes: Set<string> }>()
  for (const r of rows) {
    const keyParts = r.key.split('/')
    const displayParts = r.display.split('/')
    for (let depth = 1; depth <= keyParts.length; depth++) {
      const key = keyParts.slice(0, depth).join('/')
      if (!key) continue
      const own = depth === keyParts.length
      const display = displayParts.slice(0, depth).join('/')
      const chip = chips.get(key)
      if (!chip) chips.set(key, { display, own, notes: new Set([r.noteId]) })
      else {
        chip.notes.add(r.noteId)
        if (own && !chip.own) Object.assign(chip, { display, own: true })
      }
    }
  }
  return [...chips.entries()]
    .map(([key, c]) => ({ key, display: c.display, count: c.notes.size }))
    .sort((a, b) => a.display.localeCompare(b.display, undefined, { sensitivity: 'base' }))
}

/** Ids of notes carrying `filter` or a tag nested under it. */
export function noteIdsForTag(rows: readonly NoteTagRow[], filter: string): Set<string> {
  const out = new Set<string>()
  for (const r of rows) if (tagMatchesFilter(r.key, filter)) out.add(r.noteId)
  return out
}
