/**
 * Pasted text: a long plain-text paste into the composer becomes a chip, and
 * on send a block of the message text the agent receives inline — not a file,
 * so it reaches every engine, including drivers without attachments.
 *
 * `messages.content` holds exactly what the model received, so a paste is
 * recognised back from the text alone (no column), the way reference lines
 * are (`splitPathRefs`):
 *
 *     <pasted_text lines="48">
 *     …raw text…
 *     </pasted_text>
 *
 *     reply politely, decline the meeting
 *
 * The queue can merge several messages into one sent text, so a block may sit
 * anywhere a block boundary is (message start or after a blank line). Only the
 * exact shape {@link withPastes} writes is a block: opening tag alone on its
 * line with a `lines` count that matches the body, closing tag alone on its
 * line, a blank line or the message end after it. Anything else stays text.
 */

/** A paste becomes a chip at this many lines, or at {@link PASTE_CHIP_MIN_CHARS}, whichever comes first. */
export const PASTE_CHIP_MIN_LINES = 20
export const PASTE_CHIP_MIN_CHARS = 2_000
/** Above this many characters a paste is refused rather than chipped. */
export const PASTE_MAX_CHARS = 200_000

/** One paste in the composer draft. */
export interface ComposerPaste {
  id: string
  /** Normalised by {@link normalizePaste}. */
  text: string
}

export type PastedTextSegment = { kind: 'text'; text: string } | { kind: 'paste'; text: string; lines: number }

const OPEN_TAG = /^<pasted_text lines="([1-9]\d*)">$/
const CLOSE_TAG = '</pasted_text>'
// `<` + any run of backslashes + `/pasted_text>`. Writing adds one backslash
// and reading removes one, so a paste that already holds an escaped tag (a
// message copied out of Cinna) round-trips too.
const CLOSE_TAG_ESCAPED = /<(\\*)\/pasted_text>/g
const UNESCAPE = /<\\(\\*)\/pasted_text>/g

/** CRLF and lone CR as LF, leading and trailing blank (whitespace-only) lines dropped, the inside verbatim. */
export function normalizePaste(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t\f\v]*\n)+/, '')
    .replace(/(?:\n[ \t\f\v]*)+$/, '')
}

/** How many lines `text` spans. */
export function pasteLineCount(text: string): number {
  return text.split('\n').length
}

/** Whether a normalised paste is long enough to become a chip instead of textarea text. */
export function shouldChipPaste(text: string): boolean {
  return text.length >= PASTE_CHIP_MIN_CHARS || pasteLineCount(text) >= PASTE_CHIP_MIN_LINES
}

/** The block a paste becomes in the sent message. */
export function pasteBlock(text: string): string {
  const body = text.replace(/\r\n?/g, '\n').replace(CLOSE_TAG_ESCAPED, '<\\$1/pasted_text>')
  return `<pasted_text lines="${pasteLineCount(body)}">\n${body}\n${CLOSE_TAG}`
}

/**
 * The outgoing message: each paste as a block, then the typed text — material
 * first, instruction after — separated by blank lines. Empty pastes are skipped.
 */
export function withPastes(text: string, pastes: readonly Pick<ComposerPaste, 'text'>[]): string {
  const blocks = pastes.filter((paste) => paste.text.length > 0).map((paste) => pasteBlock(paste.text))
  if (blocks.length === 0) return text
  return text ? `${blocks.join('\n\n')}\n\n${text}` : blocks.join('\n\n')
}

/**
 * The inverse of {@link withPastes}: the message as text and paste segments in
 * order. Text segments lose the blank line that separated them from a block;
 * whitespace-only ones are dropped. A message with no blocks is one text segment
 * (none when empty).
 */
export function splitPastes(content: string): PastedTextSegment[] {
  const segments: PastedTextSegment[] = []
  if (!content.includes(CLOSE_TAG)) return content.trim() ? [{ kind: 'text', text: content }] : []
  const lines = content.split('\n')
  let textLines: string[] = []
  const flushText = (): void => {
    const text = textLines.join('\n')
    if (text.trim()) segments.push({ kind: 'text', text })
    textLines = []
  }
  let i = 0
  while (i < lines.length) {
    const block = i === 0 || lines[i - 1] === '' ? blockAt(lines, i) : null
    if (!block) {
      textLines.push(lines[i])
      i++
      continue
    }
    // The blank line before the block is a separator, not part of the text.
    if (textLines.length > 0 && textLines[textLines.length - 1] === '') textLines.pop()
    flushText()
    segments.push({ kind: 'paste', text: block.text, lines: block.lines })
    i = block.end + 1
    // …and so is the one after it.
    if (i < lines.length && lines[i] === '') i++
  }
  flushText()
  return segments
}

/** The block opening at `lines[start]`, or null when the shape is not exactly the one {@link pasteBlock} writes. */
function blockAt(lines: readonly string[], start: number): { text: string; lines: number; end: number } | null {
  const open = OPEN_TAG.exec(lines[start])
  if (!open) return null
  const end = lines.indexOf(CLOSE_TAG, start + 1)
  if (end === -1) return null
  if (end + 1 < lines.length && lines[end + 1] !== '') return null
  const count = Number(open[1])
  if (end - start - 1 !== count) return null
  const text = lines.slice(start + 1, end).join('\n').replace(UNESCAPE, '<$1/pasted_text>')
  return { text, lines: count, end }
}

/** The summary a block stands as in one-line views. */
export function pasteSummary(lines: number): string {
  return `[Pasted text · ${lines} ${lines === 1 ? 'line' : 'lines'}]`
}

/** The message with each block replaced by {@link pasteSummary}, for snippets, titles and the auto-title prompt. */
export function summarizeUserText(content: string): string {
  const segments = splitPastes(content)
  if (!segments.some((segment) => segment.kind === 'paste')) return content
  return segments.map((segment) => (segment.kind === 'paste' ? pasteSummary(segment.lines) : segment.text)).join('\n\n')
}

/** The message as a reader copies it: pastes' raw text and the typed text, no tags. */
export function readableUserText(content: string): string {
  const segments = splitPastes(content)
  if (!segments.some((segment) => segment.kind === 'paste')) return content
  return segments.map((segment) => segment.text).join('\n\n')
}

/** The typed text of a message, blocks removed; '' when it was pastes alone. */
export function typedText(content: string): string {
  const segments = splitPastes(content)
  if (!segments.some((segment) => segment.kind === 'paste')) return content
  return segments
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('\n\n')
}

export const PASTE_LABEL_MAX = 40

/**
 * What a chip or card names a paste by: its first non-empty line, leading `>`
 * quote markers stripped, whitespace collapsed, cut at {@link PASTE_LABEL_MAX}
 * characters with an ellipsis. 'Pasted text' when nothing readable is left.
 */
export function pasteLabel(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^[\s>]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!line) continue
    return line.length > PASTE_LABEL_MAX ? line.slice(0, PASTE_LABEL_MAX).trimEnd() + '…' : line
  }
  return 'Pasted text'
}

/** What a chip or card says about a paste's size: its line count, or for a single long line the characters. */
export function pasteSizeLabel(text: string): string {
  const lines = pasteLineCount(text)
  if (lines > 1) return `${lines.toLocaleString('en-US')} lines`
  return `${text.length.toLocaleString('en-US')} chars`
}
