import { stripCinnaAttachTags } from '../../../../../shared/cinnaAttach'
import { splitPastes } from '../../../../../shared/pastedText'

/**
 * Matching for chat search, in the renderer: which loaded messages a query
 * finds (chat scope), how often, and the text ranges a match covers in the
 * rendered DOM. Plain case-insensitive substring matching, the same rule
 * main's `LIKE` applies to all chats.
 */

/** The ⌘F label for this platform. */
export function findShortcutLabel(): string {
  return /Mac/i.test(navigator.userAgent) ? '⌘F' : 'Ctrl+F'
}

/** Occurrences of `query` in `text`, case-insensitive, not overlapping. */
export function countMatches(text: string, query: string): number {
  const q = query.toLowerCase()
  if (!q) return 0
  const hay = text.toLowerCase()
  let n = 0
  for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + q.length)) n++
  return n
}

/** What a message's search snippet renders: its readable text, without paste or attach markup. */
export function snippetMarkdown(role: 'user' | 'assistant', content: string): string {
  if (role === 'assistant') return stripCinnaAttachTags(content)
  return splitPastes(content).map((segment) => segment.text).join('\n\n')
}

export interface ChatMessageHit<M> {
  message: M
  /** Matches in the message's text. */
  count: number
}

/**
 * The user and assistant messages of one chat that contain `query`, in
 * transcript order (oldest first).
 */
export function searchChatMessages<M extends { role: string; content: string }>(
  messages: readonly M[],
  query: string
): ChatMessageHit<M>[] {
  const q = query.trim()
  if (!q) return []
  const hits: ChatMessageHit<M>[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const count = countMatches(snippetMarkdown(message.role, message.content), q)
    if (count > 0) hits.push({ message, count })
  }
  return hits
}

const DAY_MS = 86_400_000

/** "Today 09:26", "Yesterday 14:12", "Mon 10:05" within the week, else "14 Oct". */
export function searchTimeLabel(at: Date, now: Date): string {
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(now) - midnight(at)) / DAY_MS)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (days <= 0) return `Today ${time}`
  if (days === 1) return `Yesterday ${time}`
  if (days < 7) return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return at.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/**
 * The ranges `query` covers in the text under `root`, case-insensitive. Text
 * inside buttons and icons is skipped: it is chrome, not the message.
 */
export function textRanges(root: Node, query: string): Range[] {
  const q = query.toLowerCase()
  const out: Range[] = []
  if (!q) return out
  const doc = root.ownerDocument ?? document
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest('button, svg')) continue
    const hay = node.data.toLowerCase()
    for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + q.length)) {
      const range = doc.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + q.length)
      out.push(range)
    }
  }
  return out
}

/**
 * The CSS Custom Highlight API, when the engine has it (jsdom does not): the
 * matches are painted without touching React's DOM.
 */
interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => void
}
function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const ctor = (globalThis as { Highlight?: unknown }).Highlight
  return css?.highlights && typeof ctor === 'function' ? css.highlights : null
}

/** Highlight names, painted by `::highlight(...)` in main.css. */
export const HIGHLIGHT = {
  /** Every match in the transcript. */
  all: 'chat-search-all',
  /** The match a result jumped to. */
  current: 'chat-search-current',
  /** The matches inside result snippets. */
  snippet: 'chat-search-snippet'
} as const

export function paintHighlight(name: string, ranges: readonly Range[]): void {
  const highlights = registry()
  if (!highlights) return
  if (ranges.length === 0) {
    highlights.delete(name)
    return
  }
  const Ctor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight
  highlights.set(name, new Ctor(...ranges))
}

export function clearHighlight(name: string): void {
  registry()?.delete(name)
}

/**
 * Snippet ranges, one entry per mounted snippet, painted together under
 * {@link HIGHLIGHT.snippet}.
 */
const snippetRanges = new Map<object, Range[]>()
export function setSnippetRanges(owner: object, ranges: Range[] | null): void {
  if (ranges && ranges.length > 0) snippetRanges.set(owner, ranges)
  else snippetRanges.delete(owner)
  paintHighlight(HIGHLIGHT.snippet, [...snippetRanges.values()].flat())
}
