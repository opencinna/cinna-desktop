// Inline `#tags` in a note body, read the way Cinna Assistant (mobile) reads
// them: a port of the read side of the mobile app's `src/notes/tags.ts`, rule
// for rule, following Obsidian's tag format so a note moves between the apps
// without conversion:
//
//   - `#` + one or more of: letters, numbers, `_`, `-`, `/`, other Unicode
//     letters/marks/symbols including emoji. Anything else (a space, `.`, `,`,
//     `#`, brackets, quotes…) ends the tag.
//   - at least one non-numeric character: `#1984` is not a tag, `#y1984` is.
//   - case-insensitive: the key is the lower-cased form, the display form is the
//     casing first seen.
//   - nested with `/`: a filter on `inbox` matches `#inbox` and `#inbox/…`.
//   - the `#` must start a word (line start or after whitespace), so `foo#bar`,
//     a URL fragment, `\#escaped` and `# Heading` are not tags.
//   - fenced code blocks, inline code spans and link text/URLs are ignored.
//
// Pure and dependency-free (tested in tags.test.ts). The desktop only reads.

/** A tag occurrence inside one line or span of text. */
export interface TagMatch {
  /** Offset of the `#`. */
  start: number
  /** Offset just past the tag. */
  end: number
  /** As written, without the `#`. */
  display: string
  /** Lower-cased display: the identity used for matching. */
  key: string
}

/** A tag of a note: its key and the casing first seen in the body. */
export interface NoteTag {
  key: string
  display: string
}

// Letters, marks, numbers, `_`, `-`, `/`, symbols (emoji live in \p{So}),
// pictographs and the joiner/variation selector that build composite emoji.
// Kept a literal with `/u`, as on mobile (a regex rebuilt from `.source` can
// lose astral matching under some transpilers).
const TAG_BODY = /^[\p{L}\p{M}\p{N}\p{So}\p{Extended_Pictographic}_\-/‍️]+/u
const ALL_DIGITS = /^\p{N}+$/u

export const tagKey = (display: string): string => display.toLowerCase()

/** Whether `body` (no `#`) is a valid tag under the format rules. */
export function isValidTag(body: string): boolean {
  const m = TAG_BODY.exec(body)
  if (!m || m[0].length !== body.length) return false
  const trimmed = body.replace(/\/+$/, '')
  return trimmed.length > 0 && !ALL_DIGITS.test(trimmed)
}

export const isWordStart = (prev: string | undefined): boolean => prev === undefined || /\s/.test(prev)

// Emphasis markers are see-through for the word-start rule, so the raw line and
// the rendered text agree: `**#urgent**` is a tag in both, `x**#y**` in neither.
const EMPHASIS = /[*_~]/

/**
 * Tags in a run of plain text (no code handling: callers pass text outside code).
 * `prevChar` is the character before `text` in its line, so a span that starts
 * mid-word (`foo**#bar**`) isn't read as a word start.
 */
export function findTagsInText(text: string, prevChar?: string): TagMatch[] {
  const out: TagMatch[] = []
  for (let i = text.indexOf('#'); i >= 0; i = text.indexOf('#', i + 1)) {
    // Step back over emphasis markers, then require a word start.
    let j = i - 1
    let underscore = false
    while (j >= 0 && EMPHASIS.test(text[j])) {
      if (text[j] === '_') underscore = true
      j--
    }
    if (!isWordStart(j >= 0 ? text[j] : prevChar)) continue
    const m = TAG_BODY.exec(text.slice(i + 1))
    if (!m) continue
    // A trailing `/` is a separator, not part of the tag (`#inbox/` → inbox);
    // after a `_` opener (`_#tag_`) the closing underscores are emphasis too.
    let display = m[0].replace(/\/+$/, '')
    if (underscore) display = display.replace(/_+$/, '').replace(/\/+$/, '')
    if (!display || ALL_DIGITS.test(display)) continue
    out.push({ start: i, end: i + 1 + display.length, display, key: tagKey(display) })
    i += display.length
  }
  return out
}

const FENCE = /^\s*(```+|~~~+)/

/** Per line: whether it is inside (or delimits) a fenced code block. An
 *  unclosed fence runs to the end. */
export function fencedLineMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = []
  let open: string | null = null
  for (const line of lines) {
    const m = FENCE.exec(line)
    if (open) {
      mask.push(true)
      // A closing fence uses the same char, at least as long as the opener.
      if (m && m[1][0] === open[0] && m[1].length >= open.length && line.trim() === m[1]) open = null
    } else if (m) {
      mask.push(true)
      open = m[1]
    } else {
      mask.push(false)
    }
  }
  return mask
}

/** The line's text outside inline code spans and links, as [offset, text] runs. */
function outsideCode(line: string): Array<[number, string]> {
  const runs: Array<[number, string]> = []
  let from = 0
  let i = 0
  while (i < line.length) {
    if (line[i] === '\\') {
      i += 2
      continue
    }
    // Link text and URL (`[a #b](https://x/#c)`) hold no tags.
    if (line[i] === '[') {
      const link = /^\[[^\]]+\]\([^)\s]+\)/.exec(line.slice(i))
      if (link) {
        if (i > from) runs.push([from, line.slice(from, i)])
        i += link[0].length
        from = i
        continue
      }
    }
    if (line[i] === '`') {
      let ticks = 1
      while (line[i + ticks] === '`') ticks++
      const fence = '`'.repeat(ticks)
      const close = line.indexOf(fence, i + ticks)
      if (close > 0) {
        if (i > from) runs.push([from, line.slice(from, i)])
        i = close + ticks
        from = i
        continue
      }
      i += ticks
      continue
    }
    i++
  }
  if (from < line.length) runs.push([from, line.slice(from)])
  return runs
}

/** Tags on one markdown line (outside inline code and links), offsets into the line. */
export function findTagsInLine(line: string): TagMatch[] {
  const out: TagMatch[] = []
  for (const [offset, text] of outsideCode(line)) {
    const prev = offset > 0 ? line[offset - 1] : undefined
    for (const t of findTagsInText(text, prev)) out.push({ ...t, start: t.start + offset, end: t.end + offset })
  }
  return out
}

/** Every tag in a note body, de-duplicated by key, first-seen casing, in order. */
export function extractTags(body: string): NoteTag[] {
  const lines = body.split('\n')
  const fenced = fencedLineMask(lines)
  const seen = new Map<string, NoteTag>()
  lines.forEach((line, i) => {
    if (fenced[i]) return
    for (const t of findTagsInLine(line)) if (!seen.has(t.key)) seen.set(t.key, { key: t.key, display: t.display })
  })
  return [...seen.values()]
}

/** Whether a tag `key` falls under a filter `key` (itself or nested below it). */
export function tagMatchesFilter(tag: string, filter: string): boolean {
  return tag === filter || tag.startsWith(`${filter}/`)
}
