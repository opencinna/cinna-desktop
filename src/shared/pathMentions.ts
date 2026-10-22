/**
 * "Mention in Cinna": files and folders handed to Cinna from outside the app
 * (the Finder Quick Action), and the reference chips they become in the
 * composer.
 *
 * A reference is a **path, not an attachment**: nothing is read or uploaded.
 * At send time each chip becomes one line of the message text naming the
 * absolute path (`withPathRefs`), which the transcript then links as a file
 * reference like any other backticked path.
 */

export type ComposerPathRefKind = 'file' | 'dir'

/** One chip in the composer. */
export interface ComposerPathRef {
  /** Absolute realpath; the dedup key, and what the message names. */
  path: string
  /** How the chip's tooltip shows it: `~/…` under the home, else absolute (or agent-relative). */
  displayPath: string
  kind: ComposerPathRefKind
}

/** What `pathMention.take()` returns: the buffered paths, resolved for the active profile. */
export interface PathMentionTake {
  refs: ComposerPathRef[]
  /**
   * The folder agent the new chat should start with: the one whose folder
   * holds the first path, else the most recently used one, else null (land on
   * the new-chat screen without changing the selected agent).
   */
  agentId: string | null
  /**
   * How `agentId` was found: `folder` (its folder holds the first path; it
   * replaces the new-chat draft's agents), `recent` (the fallback; applied only
   * when the draft has no agents yet), null when there is no `agentId`.
   */
  agentMatch: PathMentionAgentMatch
}

export type PathMentionAgentMatch = 'folder' | 'recent' | null

/** Main → renderer: paths are waiting; call `take()`. No payload. */
export const PATH_MENTION_CHANNEL = 'path-mention:pending'

/**
 * Test-only argv form of a mention, repeatable, for the E2E suite. It enters
 * the same funnel as macOS's `open-file` event.
 */
export const PATH_MENTION_ARGV_FLAG = '--cinna-mention-path='

/** The longest path a mention may name, before and after it is resolved. */
export const MAX_MENTION_PATH_LENGTH = 4096

// U+2028 and U+2029 (line and paragraph separator) end a line for some
// readers just as a newline does.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/

/**
 * Why a path may not become a chip, or null when it may: too long, or holding
 * a NUL or control character, or a line or paragraph separator (U+2028,
 * U+2029) — a line break would split the line the chip is sent as. Checked on the path as given and again on its realpath, which a symlink
 * can make into anything.
 */
export function mentionPathProblem(path: string): 'too long' | 'control characters' | null {
  if (path.length > MAX_MENTION_PATH_LENGTH) return 'too long'
  if (CONTROL_CHARS.test(path)) return 'control characters'
  return null
}

/** `refs` with each of `added` appended, skipping any whose path is already there. */
export function mergePathRefs(refs: readonly ComposerPathRef[], added: readonly ComposerPathRef[]): ComposerPathRef[] {
  const seen = new Set(refs.map((ref) => ref.path))
  const merged = [...refs]
  for (const ref of added) {
    if (seen.has(ref.path)) continue
    seen.add(ref.path)
    merged.push(ref)
  }
  return merged
}

/**
 * `text` as a CommonMark code span: fenced by a backtick run longer than the
 * longest one inside it, padded with a space where the content would otherwise
 * merge into the fence (it starts or ends with a backtick) or lose a space to
 * the span's own stripping (it starts and ends with one).
 */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = /^`|`$/.test(text) || (/^ /.test(text) && / $/.test(text) && /[^ ]/.test(text)) ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** The line a chip becomes in the sent message. */
export function pathRefLine(ref: ComposerPathRef): string {
  return `Referenced ${ref.kind === 'dir' ? 'folder' : 'file'}: ${codeSpan(ref.path)}`
}

const PATH_REF_LINE = /^Referenced (?:file|folder): (`+)([\s\S]*)\1$/

/** The path a {@link pathRefLine} names, or null when `line` is not one. */
function pathOfRefLine(line: string): string | null {
  const match = PATH_REF_LINE.exec(line)
  if (!match) return null
  const inner = match[2]
  // Undo `codeSpan`'s padding the way CommonMark does.
  return inner.length > 1 && inner.startsWith(' ') && inner.endsWith(' ') && /[^ ]/.test(inner) ? inner.slice(1, -1) : inner
}

/**
 * The inverse of {@link withPathRefs}: a sent message split into what was typed
 * and the paths of the chips that went with it. A message without trailing
 * reference lines comes back as typed, with no paths.
 */
export function splitPathRefs(message: string): { text: string; paths: string[] } {
  const at = message.lastIndexOf('\n\n')
  const text = at === -1 ? '' : message.slice(0, at)
  const block = at === -1 ? message : message.slice(at + 2)
  const paths: string[] = []
  for (const line of block.split('\n')) {
    const path = pathOfRefLine(line)
    if (path === null) return { text: message, paths: [] }
    paths.push(path)
  }
  return { text, paths }
}

/** The last segment of an absolute path, as a chip shows it; `/` for the root. */
export function pathRefLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  if (!trimmed) return path || '/'
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/**
 * The message text with the chips appended: the typed text, a blank line, one
 * line per chip. With no text, just the lines; with no chips, the text as is.
 */
export function withPathRefs(text: string, refs: readonly ComposerPathRef[]): string {
  if (refs.length === 0) return text
  const lines = refs.map(pathRefLine).join('\n')
  return text ? `${text}\n\n${lines}` : lines
}
