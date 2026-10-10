/**
 * Writing values into an agent's `credentials/.env`.
 *
 * The reader that matters is the kit's `scripts/cinna_credentials.py`
 * (`_parse_env_file`): a line is `str.strip()`-ed, split at the first `=`, the
 * value stripped again and one pair of matching quotes removed. It knows no
 * escapes, so a backslash escape would corrupt the value for it; none is ever
 * written. Instead each value gets the first form that both that reader and
 * python-dotenv (which an agent's own script may use) read back unchanged:
 *
 * 1. bare `KEY=value` — no surrounding space, no leading quote or `#`, and no
 *    ` #` (dotenv's inline comment);
 * 2. `KEY="value"` — no `\` or `"` (dotenv decodes escapes in double quotes);
 * 3. `KEY='value'` — no `\` or `'` (dotenv decodes `\\` and `\'` there);
 * 4. otherwise `KEY="value"`, which the kit reader still reads exactly and
 *    dotenv may not: a value that needs quoting (surrounding space, a leading
 *    quote or `#`, a ` #`) and also holds a backslash, or holds both `"` and `'`.
 *
 * One thing no form protects: python-dotenv expands `${NAME}` in every form
 * unless the script loads with `interpolate=False`.
 *
 * Pure text in, text out: no file access, no logging, so no value can leave
 * through here.
 */

/** Every character Python's `str.splitlines()` ends a line at, and NUL. */
const LINE_BREAKING = /[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029\0]/

/**
 * What Python's `str.isspace()` (so `str.strip()`) counts as space. Not JS
 * `trim()`'s set: Python also strips U+001C–U+001F and U+0085, and keeps
 * U+FEFF, which `trim()` removes.
 */
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g')
/** A Python-space character, for tests and readers that must agree with `str.strip()`. */
export const PY_SPACE_CHAR = new RegExp(`[${PY_SPACE}]`)

/** `text.strip()` as Python does it. */
export function pyStrip(text: string): string {
  return text.replace(PY_STRIP, '')
}

/** `text.splitlines()` as Python does it (a final break ends a line, it does not start one). */
export function pySplitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Why a value cannot be written, or null when it can. Never echoes the value.
 * Emptiness is judged as the kit reader strips. Beyond the line breakers,
 * U+001F is refused: the reader strips it like a space while JS keeps it, and
 * it is the one such character `splitlines` does not already break at.
 */
export function envValueProblem(value: unknown): string | null {
  if (typeof value !== 'string' || pyStrip(value) === '') return 'is empty'
  if (LINE_BREAKING.test(value)) return 'must be a single line'
  if (value.includes('\x1f')) return 'holds a control character'
  return null
}

/** The line for one value, in the first form both readers agree on (see the header). */
export function envLine(key: string, value: string): string {
  const bare = value === pyStrip(value) && value === value.trim() && !/^['"#]/.test(value) && !/\s#/.test(value)
  if (bare) return `${key}=${value}`
  if (!/[\\"]/.test(value)) return `${key}="${value}"`
  if (!/[\\']/.test(value)) return `${key}='${value}'`
  return `${key}="${value}"`
}

function assignmentOf(line: string): { key: string; commented: boolean } | null {
  const match = /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
  return match ? { key: match[2], commented: match[1] !== undefined } : null
}

/**
 * `text` with each of `values` set. A key's first assignment — or its
 * commented-out seed (`# KEY=`) when it has none — is replaced in place; any
 * later live assignment of it is dropped, since the reader takes the last one.
 * Keys the file does not mention are appended. Every other line, comments
 * included, is kept as it was.
 */
export function mergeEnv(text: string, values: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const keys = Object.keys(values)
  const hasLive = new Set(lines.flatMap((line) => {
    const a = assignmentOf(line)
    return a && !a.commented ? [a.key] : []
  }))
  const placed = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const a = assignmentOf(line)
    if (!a || !keys.includes(a.key)) {
      out.push(line)
      continue
    }
    // A commented seed is the slot's place only when nothing assigns the key.
    if (a.commented && (hasLive.has(a.key) || placed.has(a.key))) {
      out.push(line)
      continue
    }
    if (placed.has(a.key)) continue
    out.push(envLine(a.key, values[a.key]))
    placed.add(a.key)
  }
  for (const key of keys) if (!placed.has(key)) out.push(envLine(key, values[key]))
  return out.join(eol) + eol
}
