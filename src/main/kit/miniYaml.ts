/**
 * A purpose-built YAML reader for the two files the kit contract defines:
 * an agent's `docs/CLI_COMMANDS.yaml`, and the frontmatter of
 * `app-data/storage/STATUS.md`. The project has no YAML dependency and this is
 * not worth adding one for.
 *
 * **Supported**: indentation-based maps and sequences (nested to any depth),
 * `key: value` scalars, `- item` sequences of scalars or of maps, `#` comments,
 * single- and double-quoted scalars, `true`/`false`/`null`/`~`, integers and
 * floats, and simple inline sequences (`[a, b]`).
 *
 * **Not supported**: block scalars (`|`, `>`), inline mappings (`{a: 1}`),
 * anchors and aliases (`&`, `*`), tags (`!!str`), multi-document streams, and
 * explicit keys (`? `). A `#` inside an unquoted scalar starts a comment; quote
 * the value to keep it.
 *
 * **Unsupported input does not come back as raw text — it comes back as a
 * plausible wrong value**, which is worse than either a throw or a blank. A
 * block scalar yields the marker `"|"`; an unquoted `--tag #1 --keep` yields
 * `"--tag"`. So the three shapes that do this are *detected*: `parseWithIssues`
 * reports them, and a caller that is going to execute a value — the command
 * catalog, whose strings Phase 7 hands to a subprocess — must drop anything an
 * issue touches rather than run a command that is quietly a different command.
 *
 * Never throws: a file it cannot make sense of comes back as an empty object
 * with issues. Callers are validators, and a validator reports, it does not
 * crash.
 */

export type MiniYamlValue =
  | string
  | number
  | boolean
  | null
  | MiniYamlValue[]
  | { [key: string]: MiniYamlValue }

interface SourceLine {
  indent: number
  content: string
  /** 1-based line number in the original text, for issue attribution. */
  line: number
}

/** A construct outside the supported subset, at the line where it appears. */
export interface MiniYamlIssue {
  code: 'block_scalar' | 'skipped_line' | 'inline_comment'
  /** 1-based line number in the parsed text. */
  line: number
  message: string
}

/** Markers that open a block scalar — the whole block is dropped, so refuse it. */
const BLOCK_SCALAR_MARKERS = new Set(['|', '>', '|-', '>-', '|+', '>+', '|2', '>2'])

function toLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const withoutTabs = raw.replace(/\t/g, '  ')
    const trimmed = withoutTabs.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    if (trimmed === '---' || trimmed === '...') return
    lines.push({
      indent: withoutTabs.length - withoutTabs.trimStart().length,
      content: trimmed,
      line: index + 1
    })
  })
  return lines
}

/** Strip a trailing ` # comment` from an unquoted scalar. */
function stripComment(value: string): string {
  const idx = value.search(/\s#/)
  return idx === -1 ? value : value.slice(0, idx).trimEnd()
}

function unquote(value: string): string | null {
  if (value.length < 2) return null
  const quote = value[0]
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return null
  const inner = value.slice(1, -1)
  return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'")
}

/** Convert one scalar token to its JS value. Unknown shapes stay strings. */
export function parseScalar(raw: string): MiniYamlValue {
  const quoted = unquote(raw.trim())
  if (quoted !== null) return quoted

  const value = stripComment(raw.trim())
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') {
    return null
  }
  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (/^[-+]?\d+$/.test(value)) return Number(value)
  if (/^[-+]?(\d+\.\d*|\.\d+)$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const body = value.slice(1, -1).trim()
    if (body === '') return []
    return body.split(',').map((item) => parseScalar(item.trim()))
  }
  return value
}

function splitKey(content: string): { key: string; rest: string } | null {
  // A key ends at the first `:` that is followed by whitespace or end of line,
  // and that is not inside a quoted key.
  const quoted = /^(["'])((?:\\.|(?!\1).)*)\1\s*:(?:\s+(.*))?$/.exec(content)
  if (quoted) return { key: quoted[2], rest: (quoted[3] ?? '').trim() }
  const match = /^([^:#]+?)\s*:(?:\s+(.*))?$/.exec(content)
  if (!match) return null
  return { key: match[1].trim(), rest: (match[2] ?? '').trim() }
}

interface Cursor {
  index: number
  issues: MiniYamlIssue[]
}

/** Would this unquoted scalar lose text to the comment stripper? */
function hasInlineComment(raw: string): boolean {
  const value = raw.trim()
  if (value === '') return false
  const quote = value[0]
  if (quote === '"' || quote === "'") return false
  return /\s#/.test(value)
}

/** Record the shapes this parser reads wrong, at the line they appear on. */
function noteScalarIssues(cursor: Cursor, raw: string, line: number, label: string): void {
  const value = raw.trim()
  if (BLOCK_SCALAR_MARKERS.has(value)) {
    cursor.issues.push({
      code: 'block_scalar',
      line,
      message: `\`${label}\` opens a block scalar (${value}), which this reader does not support: the block is dropped and the value becomes "${value}". Put the text on one line, or quote it.`
    })
  } else if (hasInlineComment(value)) {
    cursor.issues.push({
      code: 'inline_comment',
      line,
      message: `\`${label}\` is unquoted and contains " #", so everything from there on is read as a comment and dropped. Quote the value to keep it.`
    })
  }
}

function parseBlock(lines: SourceLine[], cursor: Cursor, indent: number): MiniYamlValue {
  if (cursor.index >= lines.length) return null
  return lines[cursor.index].content.startsWith('-')
    ? parseSequence(lines, cursor, indent)
    : parseMap(lines, cursor, indent)
}

function parseMap(
  lines: SourceLine[],
  cursor: Cursor,
  indent: number
): { [key: string]: MiniYamlValue } {
  const map: { [key: string]: MiniYamlValue } = {}
  while (cursor.index < lines.length) {
    const line = lines[cursor.index]
    if (line.indent < indent) break
    if (line.indent > indent) {
      // Over-indented with no key to attach it to: a block scalar's body, or a
      // plain multi-line scalar's continuation. Both are dropped, so say so
      // rather than let the caller act on the truncated value.
      cursor.issues.push({
        code: 'skipped_line',
        line: line.line,
        message: `Line ${line.line} is indented past every key above it, so its text is dropped. Multi-line values are not supported; put the value on one line.`
      })
      cursor.index += 1
      continue
    }
    if (line.content.startsWith('- ') || line.content === '-') break
    const entry = splitKey(line.content)
    if (!entry) {
      cursor.index += 1
      continue
    }
    cursor.index += 1
    if (entry.rest !== '') {
      noteScalarIssues(cursor, entry.rest, line.line, entry.key)
      map[entry.key] = parseScalar(entry.rest)
      continue
    }
    const next = lines[cursor.index]
    if (next && (next.indent > indent || (next.indent === indent && next.content.startsWith('-')))) {
      map[entry.key] = parseBlock(lines, cursor, next.indent)
    } else {
      map[entry.key] = null
    }
  }
  return map
}

function parseSequence(lines: SourceLine[], cursor: Cursor, indent: number): MiniYamlValue[] {
  const items: MiniYamlValue[] = []
  while (cursor.index < lines.length) {
    const line = lines[cursor.index]
    if (line.indent !== indent || !line.content.startsWith('-')) break
    const inline = line.content === '-' ? '' : line.content.slice(1).trimStart()
    // Entries of a map item sit at the column the inline text started in.
    const childIndent = indent + (line.content.length - inline.length)
    cursor.index += 1

    if (inline === '') {
      const next = lines[cursor.index]
      items.push(next && next.indent > indent ? parseBlock(lines, cursor, next.indent) : null)
      continue
    }

    const entry = splitKey(inline)
    if (!entry) {
      items.push(parseScalar(inline))
      continue
    }

    const map: { [key: string]: MiniYamlValue } = {}
    if (entry.rest !== '') {
      noteScalarIssues(cursor, entry.rest, line.line, entry.key)
      map[entry.key] = parseScalar(entry.rest)
    } else {
      const next = lines[cursor.index]
      map[entry.key] =
        next && next.indent > childIndent ? parseBlock(lines, cursor, next.indent) : null
    }
    const rest = parseMap(lines, cursor, childIndent)
    items.push({ ...map, ...rest })
  }
  return items
}

export interface MiniYamlDocument {
  data: { [key: string]: MiniYamlValue }
  /** Constructs the reader is known to get wrong. Empty means "read as written". */
  issues: MiniYamlIssue[]
}

/**
 * Parse a whole document and report every construct outside the supported
 * subset. A caller that will *act* on a value — run it, publish it — must check
 * `issues`; a caller that only displays one may ignore them.
 */
export function parseWithIssues(text: string): MiniYamlDocument {
  try {
    const lines = toLines(text)
    if (lines.length === 0) return { data: {}, issues: [] }
    const cursor: Cursor = { index: 0, issues: [] }
    const value = parseBlock(lines, cursor, lines[0].indent)
    const data =
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return { data, issues: cursor.issues }
  } catch {
    return { data: {}, issues: [] }
  }
}

/**
 * Parse a whole document. Returns an object for a mapping document, and `{}`
 * for anything else (including an empty file), never a throw. Issues are
 * discarded — use {@link parseWithIssues} when the values will be acted on.
 */
export function parseMiniYaml(text: string): { [key: string]: MiniYamlValue } {
  return parseWithIssues(text).data
}

export interface Frontmatter {
  data: { [key: string]: MiniYamlValue }
  /** Everything after the closing `---`, verbatim. */
  body: string
}

/**
 * Split `---`-delimited YAML frontmatter from a markdown body, as
 * `app-data/storage/STATUS.md` is written. Returns `null` when the text does
 * not open with a frontmatter block.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!/^---[ \t]*\r?\n/.test(normalized)) return null
  const lines = normalized.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---' || line === '...') {
      return {
        data: parseMiniYaml(lines.slice(1, i).join('\n')),
        body: lines.slice(i + 1).join('\n')
      }
    }
  }
  return null
}
