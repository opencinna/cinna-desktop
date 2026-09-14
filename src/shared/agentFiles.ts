/**
 * Smart file references: an inline code span in a folder agent's chat that
 * names a real file or folder becomes clickable and opens the preview modal.
 *
 * Shared by both processes. The renderer uses {@link extractFileRefCandidates}
 * to pick which spans to ask about; main re-validates every candidate with
 * {@link fileRefCandidatePath} before it touches the disk, because the renderer
 * is not trusted to have applied the filter. Nothing here uses Node's `path` —
 * this module is imported by the sandboxed renderer.
 */

import { previewKindFor, type PreviewRenderKind } from './filePreview'

export type AgentFileRefKind = 'file' | 'dir'

/** One inline code span that resolved to something on disk. */
export interface AgentFileRef {
  /** The span text exactly as rendered — the lookup key in the transcript. */
  text: string
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
    let runEnd = i
    while (text[runEnd] === '`') runEnd += 1
    const run = runEnd - i
    // The closing run must be exactly as long as the opening one.
    let k = runEnd
    let close = -1
    while (k < text.length) {
      if (text[k] !== '`') {
        k += 1
        continue
      }
      let m = k
      while (text[m] === '`') m += 1
      if (m - k === run) {
        close = k
        break
      }
      k = m
    }
    if (close < 0) {
      // Unmatched: the run is literal text.
      i = runEnd
      continue
    }
    let content = text.slice(runEnd, close).replace(/\n/g, ' ')
    if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
      content = content.slice(1, -1)
    }
    out.push(content)
    i = close + run
  }
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
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let fence: { char: string; length: number } | null = null
  let indentedCode = false
  let previousBlank = true
  let inList = false
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) scanCodeSpans(paragraph.join('\n'), out)
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
      scanCodeSpans(line, out)
      continue
    }
    paragraph.push(line)
  }
  flush()
  return out
}

/**
 * The spans worth asking main about, across several markdown documents in
 * transcript order: shape-filtered, de-duplicated (first occurrence wins, which
 * is what the base heuristic's ordering relies on) and capped.
 */
export function extractFileRefCandidates(markdowns: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const markdown of markdowns) {
    for (const span of extractInlineCodeSpans(markdown)) {
      if (seen.has(span) || fileRefCandidatePath(span) === null) continue
      seen.add(span)
      out.push(span)
      if (out.length >= MAX_FILE_REF_CANDIDATES) return out
    }
  }
  return out
}

/** Code and config an agent folder is full of, previewed as plain text. */
const AGENT_TEXT_EXTENSIONS = new Set([
  'py', 'sh', 'bash', 'zsh', 'sql', 'toml', 'ini', 'cfg', 'conf', 'ts', 'tsx', 'js', 'jsx',
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
 * plus code and config as text. Separate from {@link previewKindFor} so
 * attachment behaviour stays exactly as it was.
 */
export function agentFilePreviewKindFor(filename: string): PreviewRenderKind | null {
  const kind = previewKindFor(filename)
  if (kind) return kind
  return AGENT_TEXT_EXTENSIONS.has(agentFileExtension(filename)) ? 'text' : null
}

const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])

/**
 * Whether a file holds secrets and so must never be read into the renderer.
 * Compared case-insensitively, erring towards refusing on a case-insensitive
 * filesystem. `agentDir` enables the `credentials/` rule.
 */
export function isCredentialFilePath(path: string, agentDir: string | null): boolean {
  const normalized = path.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  if (base === '.env') return true
  if (base.startsWith('.env.') && !ENV_TEMPLATES.has(base)) return true
  if (base.endsWith('.pem') || base.endsWith('.key')) return true
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519')) return true
  if (agentDir) {
    const prefix = agentDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/credentials/'
    if (normalized.toLowerCase().startsWith(prefix)) {
      return !(base === 'readme.md' || base.endsWith('.example'))
    }
  }
  return false
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

/** Failures travel as data: a thrown error's code never reaches the renderer. */
export interface AgentFileFailure {
  success: false
  code: AgentFileErrorCode
  error: string
}

export interface ResolveAgentFileRefsInput {
  agentId: string
  /** Span texts in transcript order, as {@link extractFileRefCandidates} returns them. */
  candidates: string[]
}

export type ResolveAgentFileRefsResult = { success: true; refs: AgentFileRef[] } | AgentFileFailure

/** A file or folder the renderer names back to main — re-checked on every call. */
export interface AgentFilePathInput {
  agentId: string
  path: string
}

export type AuthorizeAgentFileResult = { success: true; approved: boolean } | AgentFileFailure

export type ReadAgentFilePreviewResult =
  | { success: true; text: string; truncated: boolean }
  | AgentFileFailure

export type AgentFileActionResult = { success: true } | AgentFileFailure
