/**
 * Smart file references: an inline code span or a markdown link in a folder
 * agent's chat that names a real file or folder becomes clickable and opens
 * the preview modal.
 *
 * Shared by both processes. The renderer uses {@link extractFileRefEntries}
 * to pick which spans and links to ask about; main re-validates every entry
 * with {@link fileRefCandidatePath} or {@link fileLinkCandidatePath} before it
 * touches the disk, because the renderer is not trusted to have applied the
 * filter. Nothing here uses Node's `path` —
 * this module is imported by the sandboxed renderer.
 */

import { previewKindFor, type PreviewRenderKind } from './filePreview'

export type AgentFileRefKind = 'file' | 'dir'

/** One inline code span or markdown link that resolved to something on disk. */
export interface AgentFileRef {
  /**
   * The span text, or the link's `href`, exactly as rendered — the lookup key
   * in the transcript.
   */
  text: string
  /**
   * Whether {@link text} is an inline code span or a link `href`, so the two
   * never share a key. Absent means a span.
   */
  source?: 'span' | 'link'
  /** Absolute realpath of the file or folder. */
  path: string
  /** Relative to the agent folder when inside it, else `~/…` or absolute. */
  displayPath: string
  kind: AgentFileRefKind
  /** Decided on realpaths: a symlink out of the agent folder is outside. */
  inside: boolean
}

/** Candidates resolved per call; the rest of a very long chat is not linked. */
export const MAX_FILE_REF_CANDIDATES = 500
/** Directories the base heuristic may try a relative span against. */
export const MAX_FILE_REF_BASES = 200

const MIN_SPAN_LENGTH = 2
const MAX_SPAN_LENGTH = 512
/** Glob and shell characters: a span containing one is a command, not a path. */
const NOT_A_PATH_CHARS = /[*?[\]{}<>|"'$=`\0]/
/** `file.py:12` / `file.py:12:4` — an editor location, not part of the name. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/

/**
 * The path a span names, or null when it does not look like one.
 *
 * Deliberately conservative: main only stats what passes here, and a span that
 * reads like a command (`rm -rf *`), a URL or prose is never looked up at all.
 * A trailing `:line` or `:line:col` is stripped from the returned path.
 */
export function fileRefCandidatePath(text: unknown): string | null {
  if (typeof text !== 'string') return null
  if (text.length < MIN_SPAN_LENGTH || text.length > MAX_SPAN_LENGTH) return null
  if (/\s/.test(text)) return null
  if (text.includes('://')) return null
  if (text.startsWith('-')) return null
  if (NOT_A_PATH_CHARS.test(text)) return null
  const path = text.replace(LINE_SUFFIX, '')
  if (path === '') return null
  if (!path.includes('/') && !EXTENSION.test(path)) return null
  return path
}

/** Width of a line's leading whitespace, a tab counting as four columns. */
function indentWidth(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 4
    else break
  }
  return width
}

const FENCE_OPEN = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+/
/** Lines that are a block of their own: a code span never continues past one. */
const STANDALONE_LINE = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]|\|)/

/**
 * The code span opening at `start` (a backtick): where its opening run ends,
 * and where the closing run of the same length starts, or -1 when there is
 * none and the run is literal text.
 */
function codeSpanAt(text: string, start: number): { runEnd: number; close: number } {
  let runEnd = start
  while (text[runEnd] === '`') runEnd += 1
  const run = runEnd - start
  // The closing run must be exactly as long as the opening one.
  let k = runEnd
  while (k < text.length) {
    if (text[k] !== '`') {
      k += 1
      continue
    }
    let m = k
    while (text[m] === '`') m += 1
    if (m - k === run) return { runEnd, close: k }
    k = m
  }
  return { runEnd, close: -1 }
}

/** CommonMark code spans in one paragraph, pushed in order. */
function scanCodeSpans(text: string, out: string[]): void {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      // An escaped backtick outside a span opens nothing.
      i += 2
      continue
    }
    if (ch !== '`') {
      i += 1
      continue
    }
    const { runEnd, close } = codeSpanAt(text, i)
    if (close < 0) {
      // Unmatched: the run is literal text.
      i = runEnd
      continue
    }
    out.push(codeSpanContent(text, runEnd, close))
    i = close + (runEnd - i)
  }
}

/** A code span's text as CommonMark renders it: line endings as spaces, one padding space trimmed. */
function codeSpanContent(text: string, runEnd: number, close: number): string {
  let content = text.slice(runEnd, close).replace(/\n/g, ' ')
  if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
    content = content.slice(1, -1)
  }
  return content
}

/**
 * The inline text of a markdown document, block by block: each paragraph
 * (its lines joined by `\n`) and each line that is a block of its own, in
 * order. Fenced blocks (```` ``` ```` / `~~~`) and indented code blocks are
 * skipped.
 */
function walkInlineBlocks(markdown: string, visit: (text: string) => void): void {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let fence: { char: string; length: number } | null = null
  let indentedCode = false
  let previousBlank = true
  let inList = false
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) visit(paragraph.join('\n'))
    paragraph = []
  }

  for (const line of lines) {
    if (fence) {
      const close = FENCE_OPEN.exec(line)
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length &&
        close[2].trim() === ''
      ) {
        fence = null
      }
      continue
    }
    const open = FENCE_OPEN.exec(line)
    // A backtick fence's info string cannot contain a backtick: "```x```" is
    // inline code, not a fence.
    if (open && (open[1][0] === '~' || !open[2].includes('`'))) {
      flush()
      fence = { char: open[1][0], length: open[1].length }
      indentedCode = false
      continue
    }
    if (line.replace(/[ \t>]/g, '') === '') {
      flush()
      previousBlank = true
      continue
    }
    const indent = indentWidth(line)
    if (indentedCode) {
      if (indent >= 4) continue
      indentedCode = false
    }
    if (indent >= 4 && previousBlank && !inList && paragraph.length === 0) {
      indentedCode = true
      continue
    }
    if (LIST_ITEM.test(line)) inList = true
    else if (indent === 0 && previousBlank) inList = false
    previousBlank = false
    if (STANDALONE_LINE.test(line)) {
      flush()
      visit(line)
      continue
    }
    paragraph.push(line)
  }
  flush()
}

/**
 * Inline code spans in a markdown document, in order.
 *
 * A small scanner rather than the full parser the renderer draws with: fenced
 * blocks (```` ``` ```` / `~~~`) and indented code blocks are skipped, and
 * spans are matched with CommonMark's backtick-run rule within a paragraph.
 * Where it disagrees with the real parser the cost is a span that is not
 * linked, never a wrong link — the transcript only links a rendered inline
 * `code` whose text main resolved.
 */
export function extractInlineCodeSpans(markdown: string): string[] {
  const out: string[] = []
  if (typeof markdown !== 'string' || !markdown.includes('`')) return out
  walkInlineBlocks(markdown, (text) => scanCodeSpans(text, out))
  return out
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

/** A numeric character reference as micromark decodes it: invalid code points become U+FFFD. */
function numericEntity(value: string, base: number): string {
  const code = parseInt(value, base)
  if (
    !Number.isFinite(code) ||
    code < 9 ||
    code === 11 ||
    (code > 13 && code < 32) ||
    (code > 126 && code < 160) ||
    (code > 55_295 && code < 57_344) ||
    (code > 64_975 && code < 65_008) ||
    (code & 65_535) === 65_535 ||
    (code & 65_535) === 65_534 ||
    code > 1_114_111
  ) {
    return '\uFFFD'
  }
  return String.fromCodePoint(code)
}

/**
 * Backslash escapes and character references in a link destination, in one
 * pass as micromark's `decodeString` does them. An unknown named entity stays
 * as written; the real parser would decode it, so that link goes unlinked.
 */
function decodeDestination(raw: string): string {
  return raw.replace(/\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi, (match, escaped, entity) => {
    if (escaped) return escaped
    const name = entity as string
    if (name[0] === '#') {
      return name[1] === 'x' || name[1] === 'X' ? numericEntity(name.slice(2), 16) : numericEntity(name.slice(1), 10)
    }
    return NAMED_ENTITIES[name] ?? match
  })
}

/**
 * The `href` react-markdown hands its `a` component for a link URL: a port of
 * micromark's `normalizeUri`, which mdast-util-to-hast applies. Characters
 * outside a safe ASCII set are percent-encoded (a space becomes `%20`, `é`
 * becomes `%C3%A9`); an existing `%XX` is left alone.
 */
function normalizeHref(value: string): string {
  const alnum = (code: number): boolean =>
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  const result: string[] = []
  let start = 0
  let skip = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    let replace = ''
    if (code === 37 && alnum(value.charCodeAt(index + 1)) && alnum(value.charCodeAt(index + 2))) {
      skip = 2
    } else if (code < 128) {
      if (!/[!#$&-;=?-Z_a-z~]/.test(String.fromCharCode(code))) replace = String.fromCharCode(code)
    } else if (code > 55_295 && code < 57_344) {
      const next = value.charCodeAt(index + 1)
      if (code < 56_320 && next > 56_319 && next < 57_344) {
        replace = String.fromCharCode(code, next)
        skip = 1
      } else {
        replace = '\uFFFD'
      }
    } else {
      replace = String.fromCharCode(code)
    }
    if (replace) {
      result.push(value.slice(start, index), encodeURIComponent(replace))
      start = index + skip + 1
      replace = ''
    }
    if (skip) {
      index += skip
      skip = 0
    }
  }
  return result.join('') + value.slice(start)
}

const isLinkSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n'

/** Skips spaces and tabs with at most one line ending among them. */
function skipLinkSpace(text: string, i: number): number {
  let newlines = 0
  while (isLinkSpace(text[i])) {
    if (text[i] === '\n' && ++newlines > 1) break
    i += 1
  }
  return i
}

/**
 * The inline link at `open` (the `(` after a link's `]`): its raw destination
 * and where the link ends, or null when what follows is not a link the
 * scanner can read.
 */
function linkAt(text: string, open: number): { raw: string; end: number } | null {
  let i = skipLinkSpace(text, open + 1)
  let raw: string
  if (text[i] === '<') {
    let j = i + 1
    for (;;) {
      const ch = text[j]
      if (ch === undefined || ch === '\n' || ch === '<') return null
      if (ch === '\\' && text[j + 1] !== undefined && ASCII_PUNCTUATION.test(text[j + 1])) {
        j += 2
        continue
      }
      if (ch === '>') break
      j += 1
    }
    raw = text.slice(i + 1, j)
    i = j + 1
  } else {
    let j = i
    let depth = 0
    for (;;) {
      const ch = text[j]
      if (ch === undefined) return null
      const code = ch.charCodeAt(0)
      if (code <= 32 || code === 127) break
      if (ch === '\\' && text[j + 1] !== undefined && ASCII_PUNCTUATION.test(text[j + 1])) {
        j += 2
        continue
      }
      if (ch === '(') depth += 1
      else if (ch === ')') {
        if (depth === 0) break
        depth -= 1
      }
      j += 1
    }
    if (depth !== 0) return null
    raw = text.slice(i, j)
    i = j
  }
  if (raw === '') return null
  // An optional title, separated from the destination by whitespace.
  const afterDestination = i
  i = skipLinkSpace(text, i)
  const quote = text[i]
  if (i > afterDestination && (quote === '"' || quote === "'" || quote === '(')) {
    const closer = quote === '(' ? ')' : quote
    let j = i + 1
    for (;;) {
      const ch = text[j]
      if (ch === undefined) return null
      if (ch === '\\') {
        j += 2
        continue
      }
      if (ch === closer) break
      if (quote === '(' && ch === '(') return null
      j += 1
    }
    i = skipLinkSpace(text, j + 1)
  }
  if (text[i] !== ')') return null
  return { raw, end: i + 1 }
}

/** What a span or link in a folder agent's chat may name: its text, and which it is. */
export interface FileRefEntry {
  /** The span text, or the link's `href`. */
  text: string
  source: 'span' | 'link'
}

/**
 * Code spans and inline link destinations (as `href`s) in one paragraph,
 * pushed in the order they appear. A span inside a link's text comes before
 * its link.
 */
function scanInline(text: string, out: FileRefEntry[]): void {
  let openBrackets = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') {
      const { runEnd, close } = codeSpanAt(text, i)
      if (close >= 0) out.push({ text: codeSpanContent(text, runEnd, close), source: 'span' })
      i = close < 0 ? runEnd : close + (runEnd - i)
      continue
    }
    if (ch === '[') {
      openBrackets += 1
      i += 1
      continue
    }
    if (ch !== ']') {
      i += 1
      continue
    }
    if (openBrackets === 0) {
      i += 1
      continue
    }
    openBrackets -= 1
    if (text[i + 1] !== '(') {
      i += 1
      continue
    }
    const link = linkAt(text, i + 1)
    if (!link) {
      i += 1
      continue
    }
    out.push({ text: normalizeHref(decodeDestination(link.raw)), source: 'link' })
    i = link.end
  }
}

/**
 * Inline link destinations in a markdown document, in order, each exactly as
 * react-markdown hands it to the `a` component as `href`: the `<…>` stripped,
 * backslash escapes and character references decoded, then percent-encoded by
 * the same rule mdast-util-to-hast applies.
 *
 * The same block walk as {@link extractInlineCodeSpans}: links inside code
 * blocks and code spans are not collected. An image's destination may be —
 * no `a` renders for it, so it only costs a lookup. Reference-style links are
 * not read. Where the scanner disagrees with the real parser the cost is an
 * unlinked link, never a wrong one: the transcript only links an `a` whose
 * `href` main resolved.
 */
export function extractLinkDestinations(markdown: string): string[] {
  if (typeof markdown !== 'string' || !markdown.includes('](')) return []
  return extractInlineEntries(markdown)
    .filter((entry) => entry.source === 'link')
    .map((entry) => entry.text)
}

/** Code spans and link `href`s in a markdown document, interleaved in document order. */
function extractInlineEntries(markdown: string): FileRefEntry[] {
  const out: FileRefEntry[] = []
  walkInlineBlocks(markdown, (text) => scanInline(text, out))
  return out
}

const MAX_LINK_LENGTH = 1024
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * The path a markdown link's `href` names, or null when it is not a local
 * path: a URL with a scheme (`http:`, `mailto:`, `file:`), a protocol-relative
 * `//host`, or an in-page `#anchor` / `?query`.
 *
 * Separate from {@link fileRefCandidatePath}: a link is an explicit intent, so
 * whitespace is allowed and no extension or slash is required. A trailing
 * `:line` / `:line:col` is stripped, and `%XX` escapes are decoded (the `href`
 * arrives percent-encoded).
 *
 * A `#` is a fragment, and stripped, only when it reads as one: a line anchor
 * (`a.ts#L12`, `#L12-L20`, `#L3C4`), or a heading anchor — no `.` or `/` in it
 * — after a name with an extension (`README.md#install`). Otherwise it is part
 * of the name (`notes#1.md`). The split is on the first literal `#` of the
 * `href`, before decoding, so an encoded `%23` is always a name character; the
 * two halves are judged decoded.
 */
export function fileLinkCandidatePath(text: unknown): string | null {
  if (typeof text !== 'string') return null
  if (text.length < 1 || text.length > MAX_LINK_LENGTH) return null
  if (CONTROL_CHARS.test(text)) return null
  if (text.startsWith('#') || text.startsWith('?') || text.startsWith('//')) return null
  if (URL_SCHEME.test(text)) return null
  let path = text
  const hash = path.indexOf('#')
  if (hash >= 0) {
    const before = percentDecoded(path.slice(0, hash))
    const fragment = percentDecoded(path.slice(hash + 1))
    if (LINE_ANCHOR.test(fragment) || (!/[./]/.test(fragment) && EXTENSION.test(before))) {
      path = path.slice(0, hash)
    }
  }
  path = percentDecoded(path.replace(LINE_SUFFIX, ''))
  if (path === '' || CONTROL_CHARS.test(path)) return null
  return path
}

/** `L12`, `L12C4`, `L12-L20`, `L12-20`: an editor's line anchor. */
const LINE_ANCHOR = /^L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/

/** `%XX` escapes decoded; a malformed escape leaves the text as written. */
function percentDecoded(text: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return text
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * The spans and links worth asking main about, across several markdown
 * documents, in transcript order — spans and links interleaved as they
 * appear, because the base heuristic lets only earlier entries help later
 * ones. Shape-filtered (spans by {@link fileRefCandidatePath}, links by
 * {@link fileLinkCandidatePath}), de-duplicated per source and text (first
 * occurrence wins) and capped as one list.
 */
export function extractFileRefEntries(markdowns: readonly string[]): FileRefEntry[] {
  const seen = new Set<string>()
  const out: FileRefEntry[] = []
  for (const markdown of markdowns) {
    if (typeof markdown !== 'string' || (!markdown.includes('`') && !markdown.includes(']('))) continue
    for (const entry of extractInlineEntries(markdown)) {
      const key = `${entry.source}\0${entry.text}`
      if (seen.has(key)) continue
      const valid = entry.source === 'span' ? fileRefCandidatePath(entry.text) : fileLinkCandidatePath(entry.text)
      if (valid === null) continue
      seen.add(key)
      out.push(entry)
      if (out.length >= MAX_FILE_REF_CANDIDATES) return out
    }
  }
  return out
}

/** Code and config an agent folder is full of, previewed as plain text. */
const AGENT_TEXT_EXTENSIONS = new Set([
  'sh', 'bash', 'zsh', 'sql', 'toml', 'ini', 'cfg', 'conf', 'ts', 'tsx', 'js', 'jsx',
  'mjs', 'cjs', 'xml', 'html', 'css', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp'
])

/** Lower-cased extension of a file name or path, `''` when it has none. */
export function agentFileExtension(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = name.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 || (dot === 0 && base.length > 1) ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * How the modal renders a file from an agent folder: every attachment kind,
 * except images, plus code and config as text. Separate from {@link previewKindFor} so
 * attachment behaviour stays exactly as it was.
 */
export function agentFilePreviewKindFor(filename: string): PreviewRenderKind | null {
  const kind = previewKindFor(filename)
  // An agent file is read as text (`agent-files:read-preview`); images are
  // previewed only as attachments, so an agent's image is not previewable here.
  if (kind && kind !== 'image') return kind
  return AGENT_TEXT_EXTENSIONS.has(agentFileExtension(filename)) ? 'text' : null
}

const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])

/** SSH private keys (`id_rsa`, `id_ed25519_work`, …); the `.pub` half is public. */
const SSH_PRIVATE_KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_xmss']

/** Tool credential stores known by name alone. */
const CREDENTIAL_FILE_NAMES = new Set([
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials', '.dockercfg'
])

/** Credential stores known by their folder and name, matched as whole path segments. */
const CREDENTIAL_PATH_SUFFIXES = ['/.docker/config.json', '/.aws/credentials', '/.kube/config']

/**
 * Whether a file holds secrets and so must never be read into the renderer.
 * Compared case-insensitively, erring towards refusing on a case-insensitive
 * filesystem. `agentDir` enables the `credentials/` rule.
 */
export function isCredentialFilePath(path: string, agentDir: string | null): boolean {
  const normalized = path.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'credentials.json' || normalized.toLowerCase().includes('/agent-credentials/')) return true
  if (base === '.env') return true
  if (base.startsWith('.env.') && !ENV_TEMPLATES.has(base)) return true
  if (base.endsWith('.pem') || base.endsWith('.key')) return true
  if (SSH_PRIVATE_KEY_PREFIXES.some((prefix) => base.startsWith(prefix)) && !base.endsWith('.pub')) return true
  if (CREDENTIAL_FILE_NAMES.has(base)) return true
  const lower = normalized.toLowerCase()
  if (CREDENTIAL_PATH_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  if (agentDir) {
    const prefix = agentDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/credentials/'
    if (normalized.toLowerCase().startsWith(prefix)) {
      return !(base === 'readme.md' || base.endsWith('.example'))
    }
  }
  return false
}

/**
 * {@link isCredentialFilePath} for a reference as the transcript resolved it:
 * an inside reference is judged by its folder-relative path, so the
 * `credentials/` rule applies without knowing the agent folder; an outside one
 * by its absolute path. Main refuses the read regardless — this only keeps the
 * renderer from offering what main would refuse.
 */
export function isCredentialFileRef(ref: Pick<AgentFileRef, 'path' | 'displayPath' | 'inside'>): boolean {
  return ref.inside ? isCredentialFilePath(`/${ref.displayPath}`, '/') : isCredentialFilePath(ref.path, null)
}

/** The file name a path ends in. */
export function agentFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

/**
 * Binary documents: **Open** hands them to the OS default app even when a
 * default editor is set, because an editor would show their bytes.
 */
export const BINARY_DOCUMENT_EXTENSIONS: readonly string[] = [
  'pdf', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'numbers', 'pages', 'key',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'
]

/** Text documents: the default editor when one is set, else the OS default app. */
export const TEXT_DOCUMENT_EXTENSIONS: readonly string[] = [
  'csv', 'tsv', 'md', 'markdown', 'txt', 'log', 'json', 'yaml', 'yml'
]

/** Log and process-output extensions: `.out`, `.err` beside `.log`. */
const LOG_EXTENSIONS = new Set(['log', 'out', 'err'])

/** A rotated log: `app.log.1`, `server.log.12`. */
const ROTATED_LOG = /\.log\.\d+$/

/** Files with no extension (or only a leading dot) that are text by convention. */
const TEXT_FILE_NAMES = new Set([
  'makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'rakefile', 'gemfile', 'procfile',
  'vagrantfile', 'jenkinsfile', 'brewfile', 'justfile', 'license', 'licence', 'readme', 'changelog',
  'authors', 'contributors', 'copying', 'notice', 'todo', 'codeowners',
  '.gitignore', '.gitattributes', '.gitmodules', '.dockerignore', '.npmignore', '.editorconfig',
  '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions',
  '.prettierrc', '.eslintrc', '.babelrc', '.bashrc', '.zshrc', '.profile', '.bash_profile',
  '.env.example', '.env.sample', '.env.template'
])

/**
 * Whether a file's contents may be offered as text (**Copy contents**, **Save
 * to Notes**) without reading it first:
 *  - `text` — a type known to be text: every preview kind, the text documents,
 *    log variants and conventional names such as `Makefile` or `.gitignore`;
 *  - `binary` — one of {@link BINARY_DOCUMENT_EXTENSIONS}; never read as text;
 *  - `unknown` — anything else: offered, and main decides from the bytes.
 */
export function agentFileContentKind(name: string): 'text' | 'binary' | 'unknown' {
  const base = agentFileName(name).toLowerCase()
  if (TEXT_FILE_NAMES.has(base) || ROTATED_LOG.test(base)) return 'text'
  const extension = agentFileExtension(base)
  if (BINARY_DOCUMENT_EXTENSIONS.includes(extension)) return 'binary'
  if (
    agentFilePreviewKindFor(base) !== null ||
    TEXT_DOCUMENT_EXTENSIONS.includes(extension) ||
    LOG_EXTENSIONS.has(extension)
  ) {
    return 'text'
  }
  return 'unknown'
}

/**
 * Every type **Open** may hand to the OS default app. An allowlist because
 * `shell.openPath` runs whatever the OS associates with a type — a `.command`
 * or `.app` would execute.
 */
export const DEFAULT_APP_EXTENSIONS: readonly string[] = [
  ...TEXT_DOCUMENT_EXTENSIONS,
  ...BINARY_DOCUMENT_EXTENSIONS
]

/**
 * How **Open** hands a file to the OS. None of them executes the file:
 *  - `editor` — the user's default tool, when it is an installed editor (never
 *    for {@link BINARY_DOCUMENT_EXTENSIONS});
 *  - `default-app` — `shell.openPath`, only for {@link DEFAULT_APP_EXTENSIONS};
 *  - `text-editor` — macOS `open -t`;
 *  - `reveal` — select it in the file manager.
 */
export type AgentFileOpenStrategy = 'editor' | 'default-app' | 'text-editor' | 'reveal'

export type AgentFileErrorCode =
  /** The request was malformed. */
  | 'invalid_input'
  /** No folder agent with that id. */
  | 'agent_not_found'
  /** The path does not exist (any more). */
  | 'not_found'
  /** Outside the agent folder and not approved by the user. */
  | 'needs_consent'
  /** A secrets file: never read into the renderer. */
  | 'credential_file'
  /** A type the modal cannot render; main does not read it. */
  | 'not_previewable'
  /** A folder where a file was needed. */
  | 'not_a_file'
  | 'read_failed'
  | 'launch_failed'
  /** Over {@link MAX_AGENT_FILE_TEXT_BYTES}: a whole-file read refuses rather than truncates. */
  | 'too_large'
  /** A binary type, or bytes that are not UTF-8 text. */
  | 'not_text'

/** Failures travel as data: a thrown error's code never reaches the renderer. */
export interface AgentFileFailure {
  success: false
  code: AgentFileErrorCode
  error: string
}

export interface ResolveAgentFileRefsInput {
  agentId: string
  /** Spans and link `href`s in transcript order, as {@link extractFileRefEntries} returns them. */
  entries: FileRefEntry[]
}

export type ResolveAgentFileRefsResult = { success: true; refs: AgentFileRef[] } | AgentFileFailure

/** A file or folder the renderer names back to main — re-checked on every call. */
export interface AgentFilePathInput {
  agentId: string
  path: string
}

/**
 * What the consent dialog says Cinna will do with an outside file: `show` it
 * (preview, open — the default), `read` it whole (copy its contents, save it
 * to Notes), `reveal` it in Finder / the file manager, or open it in the
 * `browser`. An approval covers them all.
 */
export type AgentFileConsentPurpose = 'show' | 'read' | 'reveal' | 'browser'

export const AGENT_FILE_CONSENT_PURPOSES: readonly AgentFileConsentPurpose[] = ['show', 'read', 'reveal', 'browser']

export interface AuthorizeAgentFileInput extends AgentFilePathInput {
  purpose?: AgentFileConsentPurpose
}

export type AuthorizeAgentFileResult = { success: true; approved: boolean } | AgentFileFailure

export type ReadAgentFilePreviewResult =
  | { success: true; text: string; truncated: boolean }
  | AgentFileFailure

export type AgentFileActionResult = { success: true } | AgentFileFailure

/**
 * What a whole-file text read is for: `copy` its contents to the clipboard,
 * or save it as a `note` (the default). Each has its own cap.
 */
export type AgentFileTextUse = 'copy' | 'note'

export interface ReadAgentFileTextInput extends AgentFilePathInput {
  use?: AgentFileTextUse
}

/** The most a whole-file text read for **Save to Notes** takes: a note is edited in place. */
export const MAX_AGENT_FILE_TEXT_BYTES = 4 * 1024 * 1024

/** The most a whole-file text read for **Copy contents** takes, as much as a preview reads. */
export const MAX_AGENT_FILE_COPY_BYTES = 25 * 1024 * 1024

/** The whole file as UTF-8 text, never truncated. */
export type ReadAgentFileTextResult = { success: true; text: string } | AgentFileFailure
