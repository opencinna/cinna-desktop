/**
 * The frontmatter subset Cinna reads out of markdown files a folder agent, a
 * script or a person writes: `.cinna/handovers/<id>/{brief,report}.md`
 * (`handovers.ts`) and `.cinna/tasks/*.md` (`folderTasks.ts`).
 *
 * Deliberately not YAML. A top-level `key: value` per line, quoted or bare
 * scalars, a trailing ` # comment` on a bare one, and whatever nesting the
 * caller chooses to read itself. One reader, so the two file contracts cannot
 * disagree about what a quoted title or a commented status means.
 *
 * Pure: imported from main and the renderer alike.
 */

/** A scalar as this subset understands it. `null` is an empty or omitted value. */
export type FrontmatterScalar = string | number | null

/**
 * Split off the frontmatter.
 *
 * A leading UTF-8 BOM and CRLF line endings are accepted — both arrive from
 * editors on Windows and from scripts that write with `iconv`. The **closing
 * `---` is the first later line that is exactly `---`**, with no exception for
 * a ``` fence opened inside the frontmatter region. That is the whole rule, on
 * purpose: tracking fences here would mean a stray unclosed fence could swallow
 * the entire file, and the frontmatter subset has no room for a fenced value
 * anyway. A fence in the *body* is untouched, `---` inside it included.
 */
export function splitFrontmatter(text: string): { lines: string[]; body: string } | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  // `trimEnd`, not `trim`: a delimiter must start its line, so a markdown
  // horizontal rule halfway down a README never turns a document into a
  // handover, while a trailing space an editor left behind is forgiven.
  if (lines.length === 0 || !isFrontmatterDelimiter(lines[0])) return null
  const close = lines.findIndex((line, index) => index > 0 && isFrontmatterDelimiter(line))
  if (close === -1) return null
  return { lines: lines.slice(1, close), body: lines.slice(close + 1).join('\n').trim() }
}

/** A `---` line, forgiving trailing whitespace but never leading. */
export function isFrontmatterDelimiter(line: string): boolean {
  return line.trimEnd() === '---'
}

/** Strip a trailing ` # comment` from an unquoted scalar, as `miniYaml` does. */
export function stripComment(value: string): string {
  const index = value.search(/\s#/)
  return index === -1 ? value : value.slice(0, index).trimEnd()
}

/** The content of a `"…"` or `'…'` token, or null when it is not one. */
export function unquote(value: string): string | null {
  if (value.length < 2) return null
  const quote = value[0]
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return null
  const inner = value.slice(1, -1)
  return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'")
}

/**
 * One scalar token. Quoted strings keep their content; a bare integer becomes a
 * number (that is how `cinna_handover` and `depth` arrive); everything else
 * stays a string. No booleans and no floats: nothing in the handover contract
 * has one, and a `title: true` is a title.
 */
export function parseScalar(raw: string): FrontmatterScalar {
  const trimmed = raw.trim()
  const quoted = unquote(trimmed)
  if (quoted !== null) return quoted
  const value = stripComment(trimmed)
  if (value === '' || value === '~' || value === 'null') return null
  if (/^[-+]?\d+$/.test(value)) return Number(value)
  return value
}

/** `key: rest` on one line, or null when the line is not a key. */
export function splitKey(content: string): { key: string; rest: string } | null {
  const match = /^([A-Za-z0-9_.-]+)\s*:(?:\s*(.*))?$/.exec(content)
  if (!match) return null
  return { key: match[1], rest: (match[2] ?? '').trim() }
}
