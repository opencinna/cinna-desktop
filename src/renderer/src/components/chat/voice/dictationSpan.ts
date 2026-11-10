/**
 * Where a live dictation's text goes in the composer's draft. The dictation
 * starts at the caret (or replaces the selection, once its first words
 * arrive) and grows there: confirmed text is written into the draft as each
 * final lands, while the current partial is only shown, never stored. Pure
 * string work, so the composer and the recorder agree on every offset.
 */

export interface DictationSpan {
  /** Where this dictation's confirmed text starts in the draft (equals `at` until the first final). */
  origin: number
  /** The insertion point in the draft: the end of the text dictated so far. */
  at: number
  /** A selection the dictation replaces once its first words arrive. */
  replace: { from: number; to: number } | null
}

/** A span at the textarea's selection when recording starts. */
export function startSpan(selectionStart: number, selectionEnd: number, draftLength: number): DictationSpan {
  const from = clamp(Math.min(selectionStart, selectionEnd), draftLength)
  const to = clamp(Math.max(selectionStart, selectionEnd), draftLength)
  return from === to ? { origin: from, at: from, replace: null } : { origin: from, at: from, replace: { from, to } }
}

function clamp(offset: number, length: number): number {
  return Number.isFinite(offset) ? Math.max(0, Math.min(Math.trunc(offset), length)) : length
}

/** Text after the insertion point that needs no space before it. */
const NO_SPACE_BEFORE = /^[\s.,;:!?)\]}'"’”]/

interface Placed {
  value: string
  /** Where the inserted text starts and ends in `value`. */
  start: number
  end: number
}

/**
 * `text` inserted at the span, with a space before it when the text before
 * does not end in whitespace, and one after it when the text after starts
 * with a word. A pending selection is removed first.
 */
function place(draft: string, span: DictationSpan, text: string): Placed {
  let base = draft
  let at = span.at
  if (span.replace) {
    const from = clamp(span.replace.from, draft.length)
    const to = clamp(span.replace.to, draft.length)
    base = draft.slice(0, from) + draft.slice(to)
    at = from
  }
  at = clamp(at, base.length)
  const before = base.slice(0, at)
  const after = base.slice(at)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !NO_SPACE_BEFORE.test(after) ? ' ' : ''
  const start = at + lead.length
  return { value: `${before}${lead}${text}${trail}${after}`, start, end: start + text.length }
}

/** A confirmed segment written into the draft; the span moves past it. Blank text changes nothing. */
export function commitFinal(draft: string, span: DictationSpan, text: string): { draft: string; span: DictationSpan } {
  const clean = text.trim()
  if (!clean) return { draft, span }
  const placed = place(draft, span, clean)
  // The first words fix where the dictation starts, after any space put before them.
  const origin = span.replace || span.origin === span.at ? placed.start : span.origin
  return { draft: placed.value, span: { origin, at: placed.end, replace: null } }
}

/** This dictation's confirmed text, as it stands in the draft. */
export function dictatedText(draft: string, span: DictationSpan): string {
  return draft.slice(span.origin, span.at)
}

/** What the dictation should read: its confirmed text, then the current partial. */
export function dictationGoal(confirmed: string, partial: string): string {
  const tail = partial.trim()
  if (!tail) return confirmed
  return confirmed ? `${confirmed} ${tail}` : tail
}

/**
 * What the composer shows while recording: the draft with this dictation's
 * confirmed text replaced by `shown`, the text as typed out so far (see
 * `typeToward`), and where `shown` sits. The draft itself keeps the confirmed
 * text: only the display types.
 */
export function displayTyped(
  draft: string,
  span: DictationSpan,
  shown: string
): { value: string; start: number; end: number } {
  const origin = clamp(span.origin, draft.length)
  const at = clamp(Math.max(span.at, origin), draft.length)
  const base = draft.slice(0, origin) + draft.slice(at)
  if (!shown) {
    const offset = clamp(origin, base.length)
    return { value: base, start: offset, end: offset }
  }
  const placed = place(base, { origin, at: origin, replace: span.replace }, shown)
  return { value: placed.value, start: placed.start, end: placed.end }
}

/** Characters at the start of both. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * A revision this far back (a final re-punctuating its whole segment) is
 * swapped in place at once: backspacing a paragraph reads as a glitch, not
 * as typing.
 */
export const MAX_BACKSPACES = 24

/**
 * `shown` moved toward `target` by up to `steps` keystrokes, as a typist
 * would: first backspacing to where the two agree, then typing the rest.
 */
export function typeToward(shown: string, target: string, steps: number): string {
  let current = snapDeepRevision(shown, target)
  for (let n = 0; n < steps && current !== target; n++) {
    const agree = commonPrefixLength(current, target)
    current = current.length > agree ? current.slice(0, -1) : target.slice(0, current.length + 1)
  }
  return current
}

/** `shown` with a revision deeper than `MAX_BACKSPACES` applied in place. */
function snapDeepRevision(shown: string, target: string): string {
  const agree = commonPrefixLength(shown, target)
  if (shown.length - agree <= MAX_BACKSPACES) return shown
  return target.slice(0, Math.min(target.length, shown.length))
}

/** Keystrokes left to turn `shown` into `target`. */
export function keystrokesBetween(shown: string, target: string): number {
  const current = snapDeepRevision(shown, target)
  const agree = commonPrefixLength(current, target)
  return current.length - agree + target.length - agree
}

/**
 * A keystroke made while the words were still typing out, moved onto the
 * dictation's whole text. `shown` is what the composer showed and `edited`
 * the textarea's value after the key, its caret at `caret`; `full` is the
 * composer with the dictation at its goal (`displayTyped` with the goal),
 * `typed` and `goal` the dictation as shown and as the engine has it. The
 * key keeps its place relative to the dictation, so words not yet typed out
 * (confirmed ones above all) are not lost. Null when the edit falls inside
 * text the animation was still revising: what was shown is kept then.
 * An edit reaching the end of the dictation applies at the end of its whole
 * text, so a backspace there takes the goal's last character.
 */
export function editOntoGoal(
  shown: { value: string; start: number; end: number },
  edited: string,
  caret: number,
  full: { value: string; start: number; end: number },
  typed: string,
  goal: string
): { value: string; caret: number } | null {
  // The edit is the stretch of `shown` replaced; anchor its end at the caret.
  let suffix = Math.max(0, Math.min(edited.length - caret, shown.value.length))
  if (!shown.value.endsWith(edited.slice(edited.length - suffix))) suffix = 0
  const prefix = Math.min(commonPrefixLength(shown.value, edited), shown.value.length - suffix, edited.length - suffix)
  const from = prefix
  const to = shown.value.length - suffix
  const inserted = edited.slice(prefix, edited.length - suffix)
  // The key acts as if the words had finished typing out: an edit reaching
  // the dictation's end moves with that end; one before it stays; one inside
  // the typed text keeps its place where that text agrees with the goal.
  const shift = full.end - shown.end
  let a: number
  let b: number
  const inside = (x: number): number => (x <= shown.start ? x : x >= shown.end ? x + shift : full.start + (x - shown.start))
  if (to === shown.end) {
    // A key or a backspace at the end, where the caret follows the words.
    b = to + shift
    a = from >= shown.start ? Math.max(full.start, from + shift) : from
  } else if (to > shown.end) {
    b = to + shift
    a = inside(from)
  } else if (to <= shown.start) {
    a = from
    b = to
  } else {
    if (to - shown.start > commonPrefixLength(typed, goal)) return null
    a = inside(from)
    b = inside(to)
  }
  if (b < a) return null
  return { value: full.value.slice(0, a) + inserted + full.value.slice(b), caret: a + inserted.length }
}
