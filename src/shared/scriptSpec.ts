/**
 * A script's parameters, read from its source without running it: the Run
 * Script window's form. Pure; main reads the file (`userCommandService.inspect`)
 * and calls {@link parseScriptSpec}.
 *
 * Sources, merged per parameter (a later one fills gaps, never overrides):
 *
 * 1. **argparse**, statically: a small Python tokenizer finds the
 *    `add_argument(…)` calls and reads their literal arguments. A value that
 *    is not a literal is `computed` or ignored.
 * 2. **The Usage line** of the module docstring (Python) or of the leading
 *    `# Usage:` comment block (shell; its only source).
 * 3. **Option lines** of the docstring (`  --basis month   per month`): help
 *    text for a flag already known.
 *
 * **Fails closed.** Anything the reader does not expect — subparsers, a second
 * parser, `**kwargs` in a call, a custom action, a flag that is not a string
 * literal, an unterminated string — answers null, and the window shows no
 * form rather than a wrong one.
 */

export type ScriptLanguage = 'python' | 'shell' | 'other'
export type ScriptParamKind = 'positional' | 'switch' | 'value' | 'count'
export type ScriptValueType = 'text' | 'int' | 'float' | 'year' | 'date' | 'month' | 'path'

export interface ScriptSpec {
  /** As written in the command, e.g. `scripts/check.py`. */
  script: string
  language: ScriptLanguage
  /** The docstring's (or comment header's) first line. */
  summary: string | null
  /** The rest of it, verbatim. */
  description: string | null
  /** The Usage line(s), if any. */
  usage: string | null
  /** Positionals first, in declaration order, then options. */
  params: ScriptParam[]
}

export interface ScriptParam {
  /** argparse's dest (`as_of`). */
  id: string
  kind: ScriptParamKind
  /** `['--as-of']`; empty for a positional. */
  flags: string[]
  /** The dest, humanised: `as_of` → "As of". */
  label: string
  required: boolean
  /** nargs `*` / `+` / N, or `append` / `extend`. */
  multiple: boolean
  /** Each value repeats the flag (`append`): `--tag a --tag b`, not `--tag a b`. */
  repeat: boolean
  valueType: ScriptValueType
  choices: string[] | null
  /**
   * The default as the form shows it: a literal, or the literal a simple
   * constructor wraps (`Path("data")` → `data`); null for none, and for one
   * the script computes ({@link defaultComputed}).
   */
  defaultText: string | null
  /** The default is an expression the reader cannot show (`date.today().year`): "set by the script". */
  defaultComputed: boolean
  metavar: string | null
  help: string | null
  /** A switch that by its name or its help writes, deletes or pushes. Display only. */
  writes: boolean
}

/** The largest script main reads for its parameters. */
export const SCRIPT_SPEC_MAX_BYTES = 512 * 1024

/** The language by file name, then by shebang; `other` for anything this reader does not handle. */
export function scriptLanguage(fileName: string, source: string): ScriptLanguage {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.py')) return 'python'
  if (/\.(sh|bash|zsh)$/.test(lower)) return 'shell'
  const shebang = /^#!([^\n]*)/.exec(source)?.[1] ?? ''
  if (/\bpython[0-9.]*\b/.test(shebang)) return 'python'
  if (/\b(ba|z|da|k)?sh\b/.test(shebang)) return 'shell'
  return 'other'
}

/**
 * The spec of a script's source, or null when it has no parameters this
 * reader can trust. `script` is the word the command names it by; `fileName`
 * decides the language (else the shebang does).
 */
export function parseScriptSpec(source: string, options: { script: string; fileName?: string }): ScriptSpec | null {
  try {
    const language = scriptLanguage(options.fileName ?? options.script, source)
    if (language === 'python') return pythonSpec(source, options.script)
    if (language === 'shell') return shellSpec(source, options.script)
    return null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------- the Python lexer */

type PyToken =
  | { t: 'str'; value: string; computed: boolean; start: number; end: number }
  | { t: 'num'; raw: string; start: number; end: number }
  | { t: 'name'; raw: string; start: number; end: number }
  | { t: 'op'; raw: string; start: number; end: number }

class Surprise extends Error {}
const surprise = (): never => { throw new Surprise() }

const STRING_START = /^([rRbBuUfF]{0,2})('''|"""|'|")/

/** Python escapes in a non-raw literal; an unknown one keeps its backslash, as Python does. */
function unescape(body: string): string {
  return body.replace(/\\(\n|[\\'"abfnrtv]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3})/g, (_all, esc: string) => {
    switch (esc[0]) {
      case '\n': return ''
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case 'a': return '\x07'
      case 'b': return '\b'
      case 'f': return '\f'
      case 'v': return '\v'
      case 'x': case 'u': case 'U': return String.fromCodePoint(parseInt(esc.slice(1), 16))
      default:
        if (/[0-7]/.test(esc[0])) return String.fromCodePoint(parseInt(esc, 8))
        return esc
    }
  })
}

/** Tokens of a Python source: strings, numbers, names and single-character operators. Comments and line breaks go. */
function lexPython(source: string): PyToken[] {
  const tokens: PyToken[] = []
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') { i++; continue }
    if (ch === '\\' && (source[i + 1] === '\n' || source[i + 1] === '\r')) { i += 2; continue }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    const rest = source.slice(i, i + 5)
    const str = STRING_START.exec(rest)
    if (str) {
      const prefix = str[1].toLowerCase()
      const quote = str[2]
      const bodyStart = i + str[0].length
      let j = bodyStart
      let closed = -1
      while (j < n) {
        const c = source[j]
        if (c === '\\') { j += 2; continue }
        if (quote.length === 1 && c === '\n') break
        if (source.startsWith(quote, j)) { closed = j; break }
        j++
      }
      if (closed === -1) surprise()
      const body = source.slice(bodyStart, closed)
      const raw = prefix.includes('r')
      tokens.push({
        t: 'str',
        value: raw ? body : unescape(body),
        computed: prefix.includes('f') || prefix.includes('b'),
        start: i,
        end: closed + quote.length
      })
      i = closed + quote.length
      continue
    }
    const num = /^(?:0[xXoObB][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?|\.\d[\d_]*(?:[eE][+-]?\d+)?[jJ]?)/.exec(source.slice(i, i + 64))
    if (num) {
      tokens.push({ t: 'num', raw: num[0], start: i, end: i + num[0].length })
      i += num[0].length
      continue
    }
    const name = /^[A-Za-z_À-￿][A-Za-z0-9_À-￿]*/.exec(source.slice(i, i + 256))
    if (name) {
      tokens.push({ t: 'name', raw: name[0], start: i, end: i + name[0].length })
      i += name[0].length
      continue
    }
    tokens.push({ t: 'op', raw: ch, start: i, end: i + 1 })
    i++
  }
  return tokens
}

/* ---------------------------------------------------------- literal values */

type PyValue =
  | { k: 'str'; v: string }
  | { k: 'num'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'none' }
  | { k: 'seq'; items: PyValue[] }
  | { k: 'expr'; src: string }

const isOp = (token: PyToken | undefined, raw: string): boolean => token?.t === 'op' && token.raw === raw
const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** Split a token range at its top-level commas; a trailing comma leaves no empty part. */
function splitCommas(tokens: PyToken[]): PyToken[][] {
  const parts: PyToken[][] = []
  let current: PyToken[] = []
  let depth = 0
  for (const token of tokens) {
    if (token.t === 'op') {
      if (OPEN[token.raw]) depth++
      else if (token.raw === ')' || token.raw === ']' || token.raw === '}') depth--
      else if (token.raw === ',' && depth === 0) { parts.push(current); current = []; continue }
    }
    current.push(token)
  }
  if (current.length > 0) parts.push(current)
  return parts
}

/**
 * Where the bracket opened at `open` closes, or -1. With `limit`, -1 as well
 * when it does not close within that many tokens: the scan stays bounded.
 */
function closing(tokens: PyToken[], open: number, limit = Infinity): number {
  let depth = 0
  const last = Math.min(tokens.length, open + limit + 1)
  for (let i = open; i < last; i++) {
    const token = tokens[i]
    if (token.t !== 'op') continue
    if (OPEN[token.raw]) depth++
    else if (token.raw === ')' || token.raw === ']' || token.raw === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * How deep a literal may nest (`[[…]]`). Deeper is a surprise: each level
 * rescans its range, so an unbounded depth is quadratic on main's thread.
 */
const MAX_LITERAL_DEPTH = 8
/** The most tokens one `add_argument(…)` call may hold, and the most calls a script may make. */
const MAX_CALL_TOKENS = 400
const MAX_ADD_ARGUMENT_CALLS = 200
/** A Usage block longer than this is not a usage: it is ignored. */
const MAX_USAGE_LINES = 50

function literal(tokens: PyToken[], source: string, depth = 0): PyValue {
  if (depth > MAX_LITERAL_DEPTH) surprise()
  if (tokens.length === 0) return { k: 'expr', src: '' }
  const src = (): PyValue => ({ k: 'expr', src: source.slice(tokens[0].start, tokens[tokens.length - 1].end) })
  if (tokens.every((token) => token.t === 'str')) {
    if (tokens.some((token) => token.t === 'str' && token.computed)) return src()
    return { k: 'str', v: tokens.map((token) => (token.t === 'str' ? token.value : '')).join('') }
  }
  if (tokens.length === 1 && tokens[0].t === 'num') return { k: 'num', v: tokens[0].raw.replace(/_/g, '') }
  if (tokens.length === 2 && isOp(tokens[0], '-') && tokens[1].t === 'num') return { k: 'num', v: `-${tokens[1].raw.replace(/_/g, '')}` }
  if (tokens.length === 1 && tokens[0].t === 'name') {
    if (tokens[0].raw === 'True') return { k: 'bool', v: true }
    if (tokens[0].raw === 'False') return { k: 'bool', v: false }
    if (tokens[0].raw === 'None') return { k: 'none' }
  }
  const first = tokens[0]
  if (first.t === 'op' && (first.raw === '[' || first.raw === '(') && closing(tokens, 0) === tokens.length - 1) {
    return { k: 'seq', items: splitCommas(tokens.slice(1, -1)).map((part) => literal(part, source, depth + 1)) }
  }
  return src()
}

const text = (value: PyValue | undefined): string | null =>
  value?.k === 'str' ? value.v : value?.k === 'num' ? value.v : null

/* ------------------------------------------------------------ param shaping */

/** `as_of` → "As of"; `db-path` → "Db path". */
export function humanise(id: string): string {
  const words = id.replace(/^-+/, '').replace(/[_-]+/g, ' ').trim()
  return words === '' ? id : words[0].toUpperCase() + words.slice(1)
}

const WRITE_NAMES = new Set(['apply', 'write', 'force', 'delete', 'commit', 'overwrite', 'push'])
const WRITES_HELP = /\b(writes?|deletes?|overwrites?)\b/i

function writesFor(param: Pick<ScriptParam, 'kind' | 'flags' | 'help'>): boolean {
  if (param.kind !== 'switch') return false
  if (param.flags.some((flag) => WRITE_NAMES.has(flag.replace(/^-+/, '').toLowerCase()))) return true
  return param.help !== null && WRITES_HELP.test(param.help)
}

/** What a metavar says the value is (`YYYY` a year, `PATH` a path), or null. */
function typeFromMetavar(metavar: string | null): ScriptValueType | null {
  if (!metavar) return null
  const m = metavar.replace(/^<|>$/g, '')
  if (/^YYYY$/i.test(m)) return 'year'
  if (/^YYYY-MM-DD$/i.test(m) || /^DATE$/i.test(m)) return 'date'
  if (/^YYYY-MM(-01)?$/i.test(m) || /^MONTH$/i.test(m)) return 'month'
  if (/^(PATH|FILE|DIR|FOLDER|FILENAME|DIRECTORY)$/i.test(m) || /[_-](PATH|FILE|DIR)$/i.test(m) || /^\*?\.[a-z0-9]{1,5}$/i.test(m) || /\.[a-z0-9]{1,5}$/i.test(m)) return 'path'
  if (/^(N|NUM|COUNT|INT|NUMBER)$/i.test(m)) return 'int'
  return null
}

/** Refine a value's type from its metavar, name and help, without contradicting an explicit one. */
function refineType(base: ScriptValueType, id: string, metavar: string | null, help: string | null): ScriptValueType {
  const hinted = typeFromMetavar(metavar)
  if (base === 'text') {
    if (hinted) return hinted
    if (/(^|_)(path|file|dir|folder)$/i.test(id)) return 'path'
    if (/(^|_)date$/i.test(id) || (help !== null && /YYYY-MM-DD/.test(help))) return 'date'
    if (help !== null && /\bYYYY-MM\b/.test(help)) return 'month'
    return 'text'
  }
  if (base === 'int') {
    if (hinted === 'year' || /(^|_)year$/i.test(id)) return 'year'
    return 'int'
  }
  return base
}

function typeOf(value: PyValue | undefined): ScriptValueType {
  if (!value) return 'text'
  if (value.k !== 'expr') return 'text'
  const src = value.src.replace(/\s+/g, '')
  if (src === 'int') return 'int'
  if (src === 'float') return 'float'
  if (/(^|\.)Path$/.test(src) || /(^|\.)FileType\(/.test(src)) return 'path'
  if (/fromisoformat$/.test(src) || /(^|_|\.)date$/i.test(src)) return 'date'
  return 'text'
}

/** What a computed default reads as, in the form and in help that names `%(default)s`. */
export const COMPUTED_DEFAULT_TEXT = 'set by the script'

/** A constructor of a single literal (`Path("data")`, `int(5)`), so the form can show the literal. */
const SIMPLE_DEFAULT = /^(?:[A-Za-z_]\w*\.)*(?:Path|PurePath|PosixPath|str|int|float|Decimal)\(\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|(-?\d[\d_]*(?:\.\d+)?))\s*,?\s*\)$/

function simpleDefault(src: string): string | null {
  const match = SIMPLE_DEFAULT.exec(src.trim())
  if (!match) return null
  return match[1] ?? match[2] ?? match[3].replace(/_/g, '')
}

/** argparse's help with its `%(default)s` filled in and `%%` unescaped. */
function helpText(help: string, defaultText: string | null, computed = false): string {
  return help
    .replace(/%\(default\)[sdr]/g, computed ? COMPUTED_DEFAULT_TEXT : defaultText ?? 'None')
    .replace(/%\((prog|type|choices|metavar|dest)\)[sdr]/g, '')
    .replace(/%%/g, '%')
    .replace(/\s+/g, ' ')
    .trim()
}

const KNOWN_KEYWORDS = new Set(['dest', 'type', 'choices', 'default', 'action', 'nargs', 'required', 'help', 'metavar', 'const', 'version'])

/** One `add_argument(…)` call: a parameter, 'skip' (help, version, hidden), or a surprise. */
function paramFromCall(argTokens: PyToken[], source: string): ScriptParam | 'skip' {
  const names: string[] = []
  const kw = new Map<string, PyValue>()
  for (const arg of splitCommas(argTokens)) {
    if (arg.length === 0) continue
    if (isOp(arg[0], '*')) surprise()
    if (arg.length >= 2 && arg[0].t === 'name' && isOp(arg[1], '=') && !isOp(arg[2], '=')) {
      if (kw.has(arg[0].raw)) surprise()
      kw.set(arg[0].raw, literal(arg.slice(2), source))
      continue
    }
    if (kw.size > 0) surprise()
    const value = literal(arg, source)
    if (value.k !== 'str' || value.v === '') surprise()
    names.push((value as { v: string }).v)
  }
  for (const key of kw.keys()) if (!KNOWN_KEYWORDS.has(key)) surprise()
  if (names.length === 0) surprise()
  const flags = names.filter((name) => name.startsWith('-'))
  if (flags.length > 0 && flags.length !== names.length) surprise()
  if (flags.length === 0 && names.length !== 1) surprise()
  if (flags.some((flag) => !/^--?[A-Za-z0-9][\w.-]*$/.test(flag))) surprise()
  const positional = flags.length === 0

  const actionValue = kw.get('action')
  let action = 'store'
  if (actionValue) {
    if (actionValue.k === 'str') action = actionValue.v
    else if (actionValue.k === 'expr' && /(^|\.)BooleanOptionalAction$/.test(actionValue.src.replace(/\s+/g, ''))) action = 'store_true'
    else surprise()
  }
  if (action === 'help' || action === 'version') return 'skip'
  const helpValue = kw.get('help')
  if (helpValue?.k === 'expr' && /SUPPRESS/.test(helpValue.src)) return 'skip'

  const kind: ScriptParamKind = positional ? 'positional'
    : ['store_true', 'store_false', 'store_const', 'append_const'].includes(action) ? 'switch'
      : action === 'count' ? 'count'
        : ['store', 'append', 'extend'].includes(action) ? 'value'
          : surprise()
  if (positional && !['store', 'append', 'extend'].includes(action)) surprise()

  const destValue = kw.get('dest')
  if (destValue && destValue.k !== 'str') surprise()
  const longFlag = flags.find((flag) => flag.startsWith('--'))
  const id = destValue?.k === 'str' ? destValue.v
    : positional ? names[0]
      : (longFlag ?? flags[0]).replace(/^-+/, '').replace(/-/g, '_')
  if (!/^[A-Za-z_][\w]*$/.test(id)) surprise()

  const nargs = kw.get('nargs')
  const nargsText = nargs?.k === 'str' ? nargs.v : nargs?.k === 'num' ? nargs.v : nargs?.k === 'expr' ? 'REMAINDER' : null
  const takesValue = kind === 'positional' || kind === 'value'
  const multiple = takesValue && (
    nargsText === '*' || nargsText === '+' || nargsText === 'REMAINDER' ||
    (nargsText !== null && /^\d+$/.test(nargsText) && Number(nargsText) > 1) ||
    action === 'append' || action === 'extend')
  const requiredValue = kw.get('required')
  const required = positional
    ? !(nargsText === '?' || nargsText === '*' || nargsText === 'REMAINDER')
    : requiredValue?.k === 'bool' && requiredValue.v

  const choicesValue = kw.get('choices')
  let choices: string[] | null = null
  if (choicesValue?.k === 'seq') {
    const listed = choicesValue.items.map(text)
    choices = listed.every((item): item is string => item !== null) && listed.length > 0 ? listed : null
  }

  const defaultValue = kw.get('default')
  let defaultText: string | null = null
  let defaultComputed = false
  if (kind !== 'switch' && kind !== 'count' && defaultValue) {
    if (defaultValue.k === 'str' || defaultValue.k === 'num') defaultText = defaultValue.v
    else if (defaultValue.k === 'bool') defaultText = defaultValue.v ? 'True' : 'False'
    else if (defaultValue.k === 'seq') {
      const listed = defaultValue.items.map(text)
      if (listed.every((item) => item !== null)) defaultText = listed.join(' ')
      else defaultComputed = true
    } else if (defaultValue.k === 'expr' && !/SUPPRESS/.test(defaultValue.src)) {
      defaultText = simpleDefault(defaultValue.src)
      defaultComputed = defaultText === null
    }
  }

  const metavarValue = kw.get('metavar')
  const metavar = metavarValue?.k === 'str' ? metavarValue.v
    : metavarValue?.k === 'seq' && metavarValue.items.every((item) => item.k === 'str')
      ? metavarValue.items.map((item) => (item as { v: string }).v).join(' ')
      : null
  const help = helpValue?.k === 'str' ? helpText(helpValue.v, defaultText, defaultComputed) || null : null

  const base: ScriptValueType = takesValue ? typeOf(kw.get('type')) : 'text'
  const valueType = takesValue ? refineType(base, id, metavar, help) : 'text'
  const param: ScriptParam = {
    id, kind, flags, label: humanise(id), required, multiple, repeat: takesValue && action === 'append',
    valueType, choices, defaultText, defaultComputed, metavar, help, writes: false
  }
  return param
}

/* ------------------------------------------------------------- docstrings */

/** A docstring as `inspect.cleandoc` leaves it: the first line stripped, the rest dedented, blank ends trimmed. */
function cleandoc(doc: string): string {
  const lines = doc.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  let indent = Infinity
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() !== '') indent = Math.min(indent, lines[i].length - lines[i].trimStart().length)
  }
  if (indent === Infinity) indent = 0
  const out = [lines[0].trim(), ...lines.slice(1).map((line) => line.slice(indent).trimEnd())]
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

function summaryAndDescription(doc: string | null): { summary: string | null; description: string | null } {
  if (!doc) return { summary: null, description: null }
  const lines = doc.split('\n')
  const at = lines.findIndex((line) => line.trim() !== '')
  if (at === -1) return { summary: null, description: null }
  const rest = lines.slice(at + 1)
  while (rest.length > 0 && rest[0].trim() === '') rest.shift()
  const description = rest.join('\n').trimEnd()
  return { summary: lines[at].trim(), description: description === '' ? null : description }
}

/**
 * The Usage block of a docstring: the text after `Usage:`, or the indented
 * lines under it. Empty past {@link MAX_USAGE_LINES}: that is not a usage
 * line, and the reader does not spend main's time on it.
 */
function usageBlock(doc: string): string[] {
  const lines = doc.split('\n')
  const at = lines.findIndex((line) => /^\s*usage\s*:/i.test(line))
  if (at === -1) return []
  const head = lines[at]
  const indent = head.length - head.trimStart().length
  const after = head.replace(/^\s*usage\s*:\s*/i, '').trim()
  const out: string[] = []
  if (after !== '') out.push(after)
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') { if (out.length > 0) break; continue }
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent <= indent) break
    // A wrapped argparse usage continues the line above; a new form starts with the command.
    out.push(line.trim())
    if (out.length > MAX_USAGE_LINES) return []
  }
  return out
}

/* ----------------------------------------------------------- the Usage line */

/** The Usage line's items: bracketed groups kept whole, anything nested is a surprise. */
function usageItems(line: string): string[] {
  const items: string[] = []
  let current = ''
  let depth = 0
  for (const ch of line) {
    if (ch === '[') {
      if (depth > 0) surprise()
      if (current !== '') { items.push(current); current = '' }
      depth++
      current += ch
      continue
    }
    if (ch === ']') {
      if (depth === 0) surprise()
      depth--
      current += ch
      continue
    }
    if ((ch === ' ' || ch === '\t') && depth === 0) {
      if (current !== '') { items.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (depth !== 0) surprise()
  if (current !== '') items.push(current)
  return items
}

const IGNORED_GROUPS = new Set(['options', 'opts', 'flags', 'args', 'arguments', 'option', '-h', '--help', '-h|--help', '-h,--help'])

/** `a|b|c` or `{a,b,c}` → the choices, else null. */
function choicesOf(word: string): string[] | null {
  const braced = /^\{([^{}]+)\}$/.exec(word)
  const parts = braced ? braced[1].split(',') : word.includes('|') ? word.split('|') : null
  if (!parts) return null
  const trimmed = parts.map((part) => part.trim())
  return trimmed.every((part) => /^[\w.:/-]+$/.test(part) && !part.startsWith('-')) ? trimmed : null
}

/** A placeholder for a value: `<x>`, `NAME`, `YYYY-MM-DD`, `*.json`, or choices. */
function placeholder(word: string): boolean {
  return /^<[^<>]+>$/.test(word) || /^[A-Z][A-Z0-9_-]*$/.test(word) || /^\*?\.[A-Za-z0-9]+$/.test(word) || choicesOf(word) !== null
}

function positionalId(word: string, index: number): string {
  const inner = word.replace(/^<|>$/g, '')
  if (choicesOf(word)) return `arg${index + 1}`
  const id = inner.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[a-z_]/.test(id) ? id : `arg${index + 1}`
}

function usageParam(partial: Omit<ScriptParam, 'label' | 'valueType' | 'writes' | 'help' | 'defaultText' | 'defaultComputed' | 'repeat'>): ScriptParam {
  const takesValue = partial.kind === 'positional' || partial.kind === 'value'
  const hinted = takesValue && !partial.choices ? typeFromMetavar(partial.metavar) : null
  return {
    ...partial, label: humanise(partial.id), valueType: hinted ?? 'text', writes: false, help: null, defaultText: null, defaultComputed: false, repeat: false
  }
}

/** One usage line's params, or null when it is not about this script. Throws on a surprise. */
function parseUsageLine(line: string, scriptBase: string): ScriptParam[] | null {
  const items = usageItems(line)
  const at = items.findIndex((item) => (item.split('/').pop() ?? item) === scriptBase)
  if (at === -1) return null
  const params: ScriptParam[] = []
  let positionals = 0
  const rest = items.slice(at + 1)
  for (let i = 0; i < rest.length; i++) {
    let item = rest[i]
    if (item === '...' || item === '…') {
      const last = params[params.length - 1]
      if (!last || last.kind === 'switch') surprise()
      last.multiple = true
      continue
    }
    let multiple = false
    if (item.endsWith('...') || item.endsWith('…')) {
      multiple = true
      item = item.replace(/(\.\.\.|…)$/, '')
    }
    if (item.startsWith('[') && item.endsWith(']')) {
      const inner = item.slice(1, -1).trim()
      if (IGNORED_GROUPS.has(inner.toLowerCase().replace(/\s+/g, ''))) continue
      let parts = inner.split(/\s+/)
      if (parts[parts.length - 1] === '...' || parts[parts.length - 1] === '…') { multiple = true; parts = parts.slice(0, -1) }
      if (parts[0].startsWith('-')) {
        const [flagPart, eqValue] = parts[0].split('=', 2)
        const flags = flagPart.split(/[|,]/).filter((flag) => flag !== '')
        if (flags.some((flag) => !/^--?[A-Za-z0-9][\w.-]*$/.test(flag))) surprise()
        if (flags.every((flag) => flag === '-h' || flag === '--help')) continue
        const value = eqValue ?? parts[1]
        if (parts.length > (eqValue === undefined ? 2 : 1)) surprise()
        if (value !== undefined && !placeholder(value) && !/^[a-z][\w-]*$/.test(value)) surprise()
        const longFlag = flags.find((flag) => flag.startsWith('--')) ?? flags[0]
        params.push(usageParam({
          id: longFlag.replace(/^-+/, '').replace(/[-.]/g, '_'), kind: value === undefined ? 'switch' : 'value', flags,
          required: false, multiple: value !== undefined && multiple,
          choices: value ? choicesOf(value) : null, metavar: value && !choicesOf(value) ? value : null
        }))
        continue
      }
      if (parts.length !== 1 || (!placeholder(parts[0]) && !/^[a-z][\w-]*$/.test(parts[0]))) surprise()
      params.push(usageParam({
        id: positionalId(parts[0], positionals), kind: 'positional', flags: [], required: false, multiple,
        choices: choicesOf(parts[0]), metavar: choicesOf(parts[0]) ? null : parts[0].replace(/^<|>$/g, '')
      }))
      positionals++
      continue
    }
    if (item.startsWith('-')) {
      const [flagPart, eqValue] = item.split('=', 2)
      const flags = flagPart.split('|')
      if (flags.some((flag) => !/^--?[A-Za-z0-9][\w.-]*$/.test(flag))) surprise()
      const next = eqValue ?? rest[i + 1]
      const hasValue = next !== undefined && !next.startsWith('-') && !next.startsWith('[') && placeholder(next)
      if (hasValue && eqValue === undefined) i++
      const longFlag = flags.find((flag) => flag.startsWith('--')) ?? flags[0]
      params.push(usageParam({
        id: longFlag.replace(/^-+/, '').replace(/[-.]/g, '_'), kind: hasValue ? 'value' : 'switch', flags,
        required: hasValue, multiple: false,
        choices: hasValue ? choicesOf(next!) : null, metavar: hasValue && !choicesOf(next!) ? next! : null
      }))
      continue
    }
    if (placeholder(item)) {
      params.push(usageParam({
        id: positionalId(item, positionals), kind: 'positional', flags: [], required: true, multiple,
        choices: choicesOf(item), metavar: choicesOf(item) ? null : item.replace(/^<|>$/g, '')
      }))
      positionals++
      continue
    }
    // A bare word: a subcommand or an example value, which this grammar cannot tell apart.
    surprise()
  }
  return params
}

/**
 * The params of a Usage block: each line about the script, merged. Null when
 * no line names the script; throws when a line surprises, or two lines
 * disagree on the positionals.
 */
function usageParams(lines: string[], scriptBase: string): ScriptParam[] | null {
  if (lines.length > MAX_USAGE_LINES) return null
  let merged: ScriptParam[] | null = null
  // By id, and the positionals' ids in order: each line merges in time linear in its own params.
  const byId = new Map<string, ScriptParam>()
  let positionals: string[] = []
  for (const line of lines) {
    const params = parseUsageLine(line, scriptBase)
    if (params === null) continue
    const now = params.filter((param) => param.kind === 'positional').map((param) => param.id)
    if (merged === null) {
      merged = params
      for (const param of params) byId.set(param.id, param)
      positionals = now
      continue
    }
    const shorter = positionals.length <= now.length ? positionals : now
    const longer = positionals.length <= now.length ? now : positionals
    if (shorter.some((id, index) => longer[index] !== id)) surprise()
    if (now.length > positionals.length) positionals = now
    for (const param of params) {
      const known = byId.get(param.id)
      if (!known) { merged.push(param); byId.set(param.id, param) }
      else if (known.kind !== param.kind) surprise()
    }
  }
  return merged
}

/* -------------------------------------------------------- merging sources */

/** Fill `into`'s gaps from `from`: never overrides a value already read. */
function fillGaps(into: ScriptParam, from: ScriptParam): void {
  if (into.metavar === null && from.metavar !== null) into.metavar = from.metavar
  if (into.choices === null && from.choices !== null) into.choices = from.choices
  if (into.help === null && from.help !== null) into.help = from.help
  if (into.kind === 'positional' || into.kind === 'value') {
    into.valueType = refineType(into.valueType, into.id, into.metavar, into.help)
    if (into.valueType === 'text' && from.valueType !== 'text') into.valueType = from.valueType
  }
}

function same(a: ScriptParam, b: ScriptParam): boolean {
  if (a.kind === 'positional' || b.kind === 'positional') return a.kind === b.kind && a.id === b.id
  return a.flags.some((flag) => b.flags.includes(flag))
}

/** Option lines of a docstring (`  --basis month   per month`): help for flags already known. */
function applyOptionLines(doc: string, params: ScriptParam[]): void {
  const lines = doc.split('\n')
  const found = new Map<ScriptParam, string[]>()
  const byFlag = new Map<string, ScriptParam>()
  for (const param of params) for (const flag of param.flags) if (!byFlag.has(flag)) byFlag.set(flag, param)
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(--?[A-Za-z0-9][\w.-]*)((?:\s*,\s*--?[A-Za-z0-9][\w.-]*)*)(.*)$/.exec(lines[i])
    if (!match) continue
    const flags = [match[2], ...match[3].split(',').map((flag) => flag.trim()).filter((flag) => flag !== '')]
    const param = flags.map((flag) => byFlag.get(flag)).find((candidate) => candidate !== undefined)
    if (!param) continue
    const indent = match[1].length
    let help = match[4].replace(/^=/, '').trim()
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      const nextIndent = next.length - next.trimStart().length
      if (next.trim() === '' || nextIndent <= indent || next.trimStart().startsWith('-')) break
      help += ` ${next.trim()}`
      i = j
    }
    help = help.replace(/\s+/g, ' ').trim()
    if (help === '') continue
    const helps = found.get(param)
    if (helps) helps.push(help)
    else found.set(param, [help])
  }
  for (const [param, helps] of found) if (param.help === null) param.help = helps.join('\n')
}

/** Positionals first, ids and flags unique, writers marked; null for nothing to show. */
function finish(params: ScriptParam[]): ScriptParam[] | null {
  if (params.length === 0) return null
  const ids = new Set<string>()
  const flags = new Set<string>()
  for (const param of params) {
    if (ids.has(param.id)) surprise()
    ids.add(param.id)
    for (const flag of param.flags) {
      if (flags.has(flag)) surprise()
      flags.add(flag)
    }
    param.writes = writesFor(param)
  }
  return [...params.filter((param) => param.kind === 'positional'), ...params.filter((param) => param.kind !== 'positional')]
}

/** The file name a command gives its script (`scripts/check.py` → `check.py`): what a Usage line is matched against. */
export function scriptBaseName(script: string): string {
  return script.split(/[/\\]/).pop() ?? script
}

/* ------------------------------------------------------------- argparse */

/** `parents=`, `**kw`: a parser whose arguments come from somewhere this reader cannot see. */
function parserCallSurprises(args: PyToken[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token.t === 'name' && token.raw === 'parents' && isOp(args[i + 1], '=') && !isOp(args[i + 2], '=')) return true
    if (isOp(token, '*') && isOp(args[i + 1], '*') && (i === 0 || isOp(args[i - 1], ',') || isOp(args[i - 1], '('))) return true
  }
  return false
}

/** Bracket depth before each token: 0 is the statement level. */
function bracketDepths(tokens: PyToken[]): number[] {
  const depths: number[] = new Array(tokens.length)
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    depths[i] = depth
    const token = tokens[i]
    if (token.t !== 'op') continue
    if (OPEN[token.raw]) depth++
    else if (token.raw === ')' || token.raw === ']' || token.raw === '}') depth = Math.max(0, depth - 1)
  }
  return depths
}

/**
 * The index of the first token on `index`'s physical line, or -1 when that
 * line does not start a logical one: a bracket is open at its start, or a
 * token (a triple-quoted string) runs across it.
 */
function lineHead(tokens: PyToken[], depths: number[], index: number, source: string): number {
  const lineStart = source.lastIndexOf('\n', tokens[index].start) + 1
  let head = index
  while (head > 0 && tokens[head - 1].start >= lineStart) {
    // A line this long starts no assignment the reader will look at: the walk stays bounded.
    if (index - head >= MAX_CALL_TOKENS) return -1
    head--
  }
  if (head > 0 && tokens[head - 1].end > lineStart) return -1
  return depths[head] === 0 ? head : -1
}

/**
 * The name the call at `callee` (the token naming the function) is assigned
 * to, read from its line: `name = [mod.]callee(` or `name: T = [mod.]callee(`,
 * starting a logical line. Null for anything else (an attribute target, a
 * return, an argument, a continuation line inside another call, a call split
 * over lines before its name). `target` is the index of the name's token.
 */
function assignedName(tokens: PyToken[], depths: number[], callee: number, source: string): { name: string; target: number } | null {
  const target = lineHead(tokens, depths, callee, source)
  if (target === -1) return null
  const token = tokens[callee]
  const head = source.slice(tokens[target].start, token.end)
  const match = /^([A-Za-z_]\w*)[ \t]*(?::[ \t]*[A-Za-z_][\w.]*[ \t]*)?=[ \t]*(?:[A-Za-z_]\w*[ \t]*\.[ \t]*)*[A-Za-z_]\w*$/.exec(head)
  return match ? { name: match[1], target } : null
}

const BINDING_KEYWORDS = new Set(['for', 'as', 'def', 'class', 'import'])

/**
 * Whether the name token at `k` binds the name: `k = …`, `k: T = …`,
 * `k += …` (any augmented operator), `k := …`, `k, other = …`, or the name
 * after `for` / `as` / `def` / `class` / `import`. Errs towards yes.
 */
function bindsName(tokens: PyToken[], depths: number[], k: number, source: string): boolean {
  const before = tokens[k - 1]
  if (isOp(before, '.')) return false
  if (before?.t === 'name' && BINDING_KEYWORDS.has(before.raw)) return true
  const after = tokens[k + 1]
  if (!after) return false
  const rest = source.slice(after.start, after.start + 3)
  if (/^:=/.test(rest) || /^(?:\*\*|\/\/|<<|>>|[-+*/%@&|^])=/.test(rest)) return true
  if (depths[k] !== 0) return false
  if (isOp(after, ':') && lineHead(tokens, depths, k, source) !== k) return false
  if (!isOp(after, '=') && !isOp(after, ',') && !isOp(after, ':')) return false
  // A lone `=` at the statement level before the logical line ends; past the bound, yes.
  for (let i = k + 1; i < tokens.length; i++) {
    if (i - k > MAX_CALL_TOKENS) return true
    const token = tokens[i]
    if (depths[i] === 0) {
      const gap = source.slice(tokens[i - 1].end, token.start)
      if (gap.includes('\n') && !/\\\r?\n/.test(gap)) return false
      if (isOp(token, ';')) return false
    }
    if (depths[i] !== 0 || !isOp(token, '=')) continue
    const prev = tokens[i - 1]
    const next = tokens[i + 1]
    const joinedPrev = prev.t === 'op' && prev.end === token.start && /[=!<>:+\-*/%@&|^]/.test(prev.raw)
    const joinedNext = isOp(next, '=') && next.start === token.end
    if (!joinedPrev && !joinedNext) return true
    if (joinedNext) i++
  }
  return false
}

/**
 * Indentation of each token that starts a logical line (a new physical line
 * at bracket depth 0, not a backslash continuation), -1 for the rest.
 */
function lineIndents(tokens: PyToken[], depths: number[], source: string): number[] {
  const indents: number[] = new Array(tokens.length).fill(-1)
  for (let k = 0; k < tokens.length; k++) {
    if (depths[k] !== 0) continue
    const from = k === 0 ? 0 : tokens[k - 1].end
    const gap = source.slice(from, tokens[k].start)
    if (k > 0 && (!gap.includes('\n') || /\\\r?\n/.test(gap))) continue
    indents[k] = tokens[k].start - (from + gap.lastIndexOf('\n') + 1)
  }
  return indents
}

/**
 * The name of the function the parser is built in when it is a factory: the
 * nearest less indented line above the parser's assignment (token `target`)
 * is `def F(`, and F's body has a `return <parser>` statement. Null otherwise.
 */
function parserFactory(tokens: PyToken[], indents: number[], target: number, parser: string): string | null {
  const indent = indents[target]
  let def = -1
  for (let k = target - 1; k >= 0; k--) {
    if (indents[k] === -1 || indents[k] >= indent) continue
    const head = tokens[k]
    const next = tokens[k + 1]
    if (head.t === 'name' && head.raw === 'async' && next?.t === 'name' && next.raw === 'def') def = k + 1
    else if (head.t === 'name' && head.raw === 'def') def = k
    break
  }
  const name = tokens[def + 1]
  if (def === -1 || name?.t !== 'name' || !isOp(tokens[def + 2], '(')) return null
  const defIndent = indents[def] === -1 ? indents[def - 1] : indents[def]
  for (let k = target + 1; k < tokens.length; k++) {
    if (indents[k] !== -1 && indents[k] <= defIndent) break
    const value = tokens[k + 1]
    const statement = tokens[k]
    if (indents[k] === -1 || statement.t !== 'name' || statement.raw !== 'return') continue
    if (value?.t !== 'name' || value.raw !== parser) continue
    const after = tokens[k + 2]
    if (after === undefined || indents[k + 2] !== -1 || isOp(after, ';')) return name.raw
  }
  return null
}

/**
 * The params of the script's one argparse parser, in declaration order, or []
 * when it has none. Throws a surprise for anything that could make the form
 * wrong: no parser, two, one not assigned to a name, `parents=`, subparsers,
 * an `add_argument` on anything but the parser or one of its groups, no
 * `parse_args` on it, the parser's or a group's name bound anywhere else
 * (`parser = Fake()`), or more than the reader will look at. A factory —
 * the parser built in `def F(…)` that returns it — may be called: `X = F(…)`
 * starting a logical line makes X the parser too, and `F(…).parse_args(`
 * parses it.
 */
function argparseParams(tokens: PyToken[], source: string): ScriptParam[] {
  const depths = bracketDepths(tokens)
  // The parser: exactly one `ArgumentParser(`, assigned to a plain name.
  let parser: string | null = null
  let parserTarget = -1
  const targets = new Set<number>()
  let calls = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.t !== 'name') continue
    if (token.raw === 'add_subparsers') surprise()
    if (token.raw === 'add_argument' && isOp(tokens[i + 1], '(')) calls++
    if (token.raw !== 'ArgumentParser' || !isOp(tokens[i + 1], '(')) continue
    if (parser !== null) surprise()
    const assigned = assignedName(tokens, depths, i, source)
    if (assigned === null) return surprise()
    parser = assigned.name
    parserTarget = assigned.target
    targets.add(assigned.target)
    const end = closing(tokens, i + 1, MAX_CALL_TOKENS)
    if (end === -1 || parserCallSurprises(tokens.slice(i + 2, end))) surprise()
  }
  if (parser === null) return calls === 0 ? [] : surprise()
  if (calls > MAX_ADD_ARGUMENT_CALLS) surprise()

  // A factory's calls: `X = F(…)` names the parser X too; `F(…).parse_args(` parses it.
  const parsers = new Set<string>([parser])
  let parsed = false
  const indents = lineIndents(tokens, depths, source)
  const factory = parserFactory(tokens, indents, parserTarget, parser)
  if (factory !== null) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.t !== 'name' || token.raw !== factory || !isOp(tokens[i + 1], '(') || isOp(tokens[i - 1], '.')) continue
      const before = tokens[i - 1]
      if (before?.t === 'name' && before.raw === 'def') continue
      const end = closing(tokens, i + 1, MAX_CALL_TOKENS)
      if (end === -1) continue
      const method = tokens[end + 2]
      if (isOp(tokens[end + 1], '.')) {
        if (method?.t === 'name' && (method.raw === 'parse_args' || method.raw === 'parse_known_args') && isOp(tokens[end + 3], '(')) parsed = true
        continue
      }
      // `X = F(…)` and nothing more on the logical line: X is the parser.
      const next = tokens[end + 1]
      if (next !== undefined && indents[end + 1] === -1 && !isOp(next, ';')) continue
      const assigned = assignedName(tokens, depths, i, source)
      if (assigned === null) continue
      parsers.add(assigned.name)
      targets.add(assigned.target)
    }
  }

  // Its groups, and the calls on them, in source order.
  const receivers = new Set<string>(parsers)
  const params: ScriptParam[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.t !== 'name' || !isOp(tokens[i + 1], '(')) continue
    const receiver = isOp(tokens[i - 1], '.') ? tokens[i - 2] : undefined
    const on = receiver?.t === 'name' && !isOp(tokens[i - 3], '.') ? receiver.raw : null
    if (token.raw === 'parse_args' || token.raw === 'parse_known_args') {
      if (on !== null && parsers.has(on)) parsed = true
      continue
    }
    if (token.raw === 'add_argument_group' || token.raw === 'add_mutually_exclusive_group') {
      if (on === null || !receivers.has(on)) surprise()
      const assigned = assignedName(tokens, depths, i, source)
      if (assigned === null || parsers.has(assigned.name)) return surprise()
      receivers.add(assigned.name)
      targets.add(assigned.target)
      continue
    }
    if (token.raw !== 'add_argument') continue
    if (!isOp(tokens[i - 1], '.')) continue
    if (on === null || !receivers.has(on)) surprise()
    const end = closing(tokens, i + 1, MAX_CALL_TOKENS)
    if (end === -1) surprise()
    const param = paramFromCall(tokens.slice(i + 2, end), source)
    if (param !== 'skip') params.push(param)
    i = end
  }
  if (!parsed) surprise()

  // Receivers are matched by name: any other binding of one of those names
  // (`parser = Fake()`, before or after) could put calls on something else.
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    if (token.t !== 'name' || !receivers.has(token.raw) || targets.has(k)) continue
    if (bindsName(tokens, depths, k, source)) surprise()
  }
  return params
}

/* ------------------------------------------------------------- languages */

function pythonSpec(source: string, script: string): ScriptSpec | null {
  let tokens: PyToken[]
  try {
    tokens = lexPython(source)
  } catch {
    return null
  }
  try {
    // The module docstring: the first statement, a plain string.
    let doc: string | null = null
    let first = 0
    while (first < tokens.length && tokens[first].t === 'str') first++
    if (first > 0 && !isOp(tokens[first], '.') && !isOp(tokens[first], '(')) {
      const value = literal(tokens.slice(0, first), source)
      if (value.k === 'str') doc = cleandoc(value.v)
    }

    const fromCalls = argparseParams(tokens, source)
    const usageLines = doc ? usageBlock(doc) : []
    let fromUsage: ScriptParam[] | null = null
    try {
      fromUsage = usageLines.length > 0 ? usageParams(usageLines, scriptBaseName(script)) : null
    } catch (error) {
      // The docstring is a gap filler when argparse spoke; alone, its surprise is the script's.
      if (!(error instanceof Surprise) || fromCalls.length === 0) throw error
      fromUsage = null
    }

    let params: ScriptParam[]
    if (fromCalls.length > 0) {
      params = fromCalls
      // By name only: a Usage positional named otherwise is not the dest it
      // may stand for, and its choices must not reach a free-text field.
      for (const from of fromUsage ?? []) {
        const into = params.find((param) => same(param, from))
        if (into) fillGaps(into, from)
      }
    } else {
      params = fromUsage ?? []
    }
    if (doc) applyOptionLines(doc, params)
    const finished = finish(params)
    if (!finished) return null
    return { script, language: 'python', ...summaryAndDescription(doc), usage: usageLines.length > 0 ? usageLines.join('\n') : null, params: finished }
  } catch (error) {
    if (error instanceof Surprise) return null
    throw error
  }
}

/** The leading comment block of a shell script, after the shebang, without its `#`. */
function shellHeader(source: string): string | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let i = lines[0]?.startsWith('#!') ? 1 : 0
  while (i < lines.length && lines[i].trim() === '') i++
  const out: string[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('#')) break
    const body = line.replace(/^#\s?/, '')
    if (/^\s*shellcheck\b/.test(body)) continue
    out.push(body.trimEnd())
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.length > 0 ? out.join('\n') : null
}

function shellSpec(source: string, script: string): ScriptSpec | null {
  const header = shellHeader(source)
  if (!header) return null
  try {
    const usageLines = usageBlock(header)
    if (usageLines.length === 0) return null
    const params = usageParams(usageLines, scriptBaseName(script)) ?? []
    applyOptionLines(header, params)
    const finished = finish(params)
    if (!finished) return null
    // The header's first line is the summary unless it is the Usage line itself.
    const doc = /^\s*usage\s*:/i.test(header.split('\n')[0]) ? null : header
    return { script, language: 'shell', ...summaryAndDescription(doc), usage: usageLines.join('\n'), params: finished }
  } catch (error) {
    if (error instanceof Surprise) return null
    throw error
  }
}
