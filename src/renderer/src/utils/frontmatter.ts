/**
 * Split a markdown file's YAML frontmatter from its body, for display.
 *
 * `react-markdown` knows nothing about frontmatter: the opening `---` became a
 * rule and the closing one turned every `key: value` line above it into one
 * setext heading, so a spec file opened as a paragraph of bold run-on text.
 *
 * This is a reader for the shapes frontmatter is actually written in, not a
 * YAML parser: top-level `key: value` pairs whose value is a scalar, a quoted
 * string, a `|`/`>` block, a `[a, b]` flow list or a `- item` block list.
 * Anything deeper (a nested map, a list of maps) is kept as its source text,
 * so the reader never drops what the file says — it only declines to format it.
 *
 * Chat replies open with a `---` separator often enough that a loose match
 * turned a reply's first section into a monospace block. So a block counts
 * only when it opens with a key line and every top-level line is one; keys are
 * identifiers (`name`, `multi_company`, `og:title`), never prose like
 * `**Summary**:`. Anything else is the document's own markdown, untouched.
 */

export type FrontmatterValue =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  /** Nested YAML, shown as its (dedented) source. */
  | { kind: 'raw'; text: string }

export interface FrontmatterEntry {
  key: string
  value: FrontmatterValue
}

export interface MarkdownWithFrontmatter {
  /**
   * `null` when the text has no frontmatter; `entries` is empty for an
   * empty `---`/`---` block.
   */
  frontmatter: { entries: FrontmatterEntry[] } | null
  body: string
}

const OPEN = /^---[ \t]*$/
const CLOSE = /^(---|\.\.\.)[ \t]*$/
const KEY_LINE = /^("[^"\n]+"|'[^'\n]+'|[A-Za-z0-9_$@][\w.$@/-]*(?::[\w.$@/-]+)*)[ \t]*:(?:[ \t]+(.*))?$/
const LIST_ITEM = /^[ \t]*-(?:[ \t]+(.*))?$/

export function splitFrontmatter(text: string): MarkdownWithFrontmatter {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = source.split(/\r?\n/)
  if (lines.length < 2 || !OPEN.test(lines[0])) return { frontmatter: null, body: text }

  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE.test(lines[i])) {
      close = i
      break
    }
  }
  if (close < 0) return { frontmatter: null, body: text }

  const block = lines.slice(1, close)
  // A document that opens with a thematic break and has another one further
  // down is not frontmatter: the first line inside must be a `key:` line — not
  // a comment, which is how a `# Heading` under a separator would read — or
  // there must be nothing at all (an empty `---\n---` block).
  const first = block.find((line) => line.trim() !== '')
  if (first !== undefined && !KEY_LINE.test(first)) return { frontmatter: null, body: text }
  const entries = parseEntries(block)
  if (!entries) return { frontmatter: null, body: text }

  return { frontmatter: { entries }, body: lines.slice(close + 1).join('\n') }
}

function parseEntries(block: string[]): FrontmatterEntry[] | null {
  const entries: FrontmatterEntry[] = []
  let i = 0
  while (i < block.length) {
    const line = block[i]
    if (line.trim() === '' || line.startsWith('#')) {
      i++
      continue
    }
    const match = KEY_LINE.exec(line)
    if (!match) return null
    const key = unquote(match[1].trim())
    const rest = (match[2] ?? '').trim()
    i++
    // Continuation: indented lines, blanks, and a `- item` list written at
    // column 0 under its key (valid YAML, and common).
    const cont: string[] = []
    while (i < block.length) {
      const next = block[i]
      if (next.trim() === '' || /^\s/.test(next) || LIST_ITEM.test(next)) {
        cont.push(next)
        i++
      } else if (next.startsWith('#')) {
        i++
      } else {
        break
      }
    }
    while (cont.length > 0 && cont[cont.length - 1].trim() === '') cont.pop()
    entries.push({ key, value: parseValue(rest, cont) })
  }
  return entries
}

function parseValue(rest: string, cont: string[]): FrontmatterValue {
  const blockScalar = /^([|>])[-+0-9]*$/.exec(rest)
  if (blockScalar) {
    const body = dedent(cont)
    if (blockScalar[1] === '|') return { kind: 'text', text: body.join('\n').replace(/\s+$/, '') }
    return { kind: 'text', text: fold(body) }
  }

  if (rest === '') {
    const content = cont.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    if (content.length === 0) return { kind: 'text', text: '' }
    const list = blockList(content)
    return list ? { kind: 'list', items: list } : { kind: 'raw', text: dedent(cont).join('\n') }
  }

  const inline = stripComment(rest)
  if (inline.startsWith('[') || inline.startsWith('{')) {
    if (cont.length === 0 && inline.startsWith('[') && inline.endsWith(']')) {
      const items = flowList(inline.slice(1, -1))
      if (items) return { kind: 'list', items }
    }
    return { kind: 'raw', text: [inline, ...dedent(cont)].join('\n') }
  }

  // A plain scalar may run onto indented lines; YAML folds them with spaces.
  const joined = cont.length > 0 ? fold([inline, ...dedent(cont)]) : inline
  return { kind: 'text', text: unquote(joined) }
}

/** Items of a `- item` list, or `null` when an item is itself a structure. */
function blockList(content: string[]): string[] | null {
  const indent = leadingSpaces(content[0])
  const items: string[] = []
  for (const line of content) {
    const item = LIST_ITEM.exec(line)
    if (!item || leadingSpaces(line) !== indent) return null
    const value = stripComment((item[1] ?? '').trim())
    if (value.startsWith('[') || value.startsWith('{') || KEY_LINE.test(value)) return null
    items.push(unquote(value))
  }
  return items
}

/** `a, "b, c", d` → items, or `null` for nested flow collections. */
function flowList(inner: string): string[] | null {
  if (inner.trim() === '') return []
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === '[' || ch === '{') {
      return null
    } else if (ch === ',') {
      items.push(unquote(current.trim()))
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim() !== '') items.push(unquote(current.trim()))
  return items
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim() !== '').map(leadingSpaces)
  const min = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(min, leadingSpaces(line))))
}

/** YAML folding: lines join with a space, a blank line is a newline. */
function fold(lines: string[]): string {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      paragraphs.push(current.join(' '))
      current = []
    } else {
      current.push(line.trim())
    }
  }
  paragraphs.push(current.join(' '))
  return paragraphs.join('\n').trim()
}

/** A YAML comment needs whitespace before `#`, so `a#b` and URLs survive. */
function stripComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) {
    const end = value.lastIndexOf(value[0])
    return end > 0 && /^\s+#/.test(value.slice(end + 1)) ? value.slice(0, end + 1) : value
  }
  return value.replace(/\s+#.*$/, '')
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\nt])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
  }
  return value
}

/**
 * A scalar written as `a,b,c` — no spaces, two or more non-empty parts — is a
 * list in all but syntax (`models: foo-(A),bar-(M)`), and reads as one.
 */
export function commaSeparatedItems(text: string): string[] | null {
  if (!text.includes(',') || /\s/.test(text)) return null
  const parts = text.split(',')
  return parts.every((part) => part !== '') ? parts : null
}

// A URL stops at whitespace, and at a comma that starts the next one
// (`https://a.io,https://b.io` is a two-item list, not one link).
const URL_PATTERN = /https?:\/\/(?:(?!,https?:\/\/)[^\s<>"'`])+/gi

/** Split text into plain runs and `http(s)` URLs, trailing punctuation excluded. */
export function linkifySegments(text: string): Array<{ text: string; href?: string }> {
  const segments: Array<{ text: string; href?: string }> = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0]
    // A sentence's full stop, or the `)` closing a parenthesis the URL opened
    // inside, belongs to the prose.
    for (;;) {
      if (/[.,;:!?'"*]$/.test(url)) url = url.slice(0, -1)
      else if (url.endsWith(')') && count(url, '(') < count(url, ')')) url = url.slice(0, -1)
      else if (url.endsWith(']') && count(url, '[') < count(url, ']')) url = url.slice(0, -1)
      else break
    }
    const start = match.index ?? 0
    if (start > last) segments.push({ text: text.slice(last, start) })
    segments.push({ text: url, href: url })
    last = start + url.length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1
}
