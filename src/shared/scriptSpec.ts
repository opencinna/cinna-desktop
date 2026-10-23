/**
 * A script's parameters, read from its source without running it: the Run
 * Script window's form. Pure; main reads the file (`userCommandService.inspect`)
 * and calls {@link parseScriptSpec}.
 *
 * Sources, merged per parameter (a later one fills gaps, never overrides):
 *
 * 1. **The script's parser**, statically: a small Python tokenizer finds
 *    argparse's `add_argument(…)` calls, click's `@click.option` /
 *    `@click.argument` stack on its one `@click.command`, or the signature of
 *    typer's one command (`typer.run(main)`, or one `@app.command()`), and
 *    reads their literal arguments; at most one of the three may speak. A
 *    value that is not a literal is `computed` or ignored. For shell, a
 *    `while getopts` loop and its `case` arms give the short options.
 * 2. **The Usage line** of the module docstring (Python) or of the leading
 *    `# Usage:` comment block (shell; with getopts it names and explains the
 *    letters, else it is the only source).
 * 3. **Option lines** of the docstring (`  --basis month   per month`): help
 *    text for a flag already known.
 *
 * **Fails closed.** Anything the reader does not expect — subparsers, a second
 * parser, a click group or second command, `@app.callback`, `**kwargs` in a
 * call, a custom action, a flag that is not a string literal, an optstring
 * that is not a literal, an unterminated string — answers null, and the
 * window shows no form rather than a wrong one.
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
  /**
   * The script stops reading options at its first operand (shell `getopts`):
   * the form writes options before positionals, and a line's words after the
   * first operand are read as operands, as the script reads them.
   */
  optionsFirst?: boolean
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
  /**
   * A switch's off flags, for one declared `--x/--no-x` (click, typer's
   * bools): the form writes one only to turn off a switch that is on by
   * default. Empty for any other param.
   */
  offFlags: string[]
  /** A switch that is on when the line names neither its flags nor its off flags. */
  defaultOn: boolean
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

const NO_DEFAULT = { defaultText: null, defaultComputed: false } as const

/** A literal default as the form shows it, or that the script computes it; nothing for None or SUPPRESS. */
function shownDefault(value: PyValue | undefined): { defaultText: string | null; defaultComputed: boolean } {
  if (!value) return NO_DEFAULT
  if (value.k === 'str' || value.k === 'num') return { defaultText: value.v, defaultComputed: false }
  if (value.k === 'bool') return { defaultText: value.v ? 'True' : 'False', defaultComputed: false }
  if (value.k === 'seq') {
    const listed = value.items.map(text)
    return listed.every((item) => item !== null) ? { defaultText: listed.join(' '), defaultComputed: false } : { defaultText: null, defaultComputed: true }
  }
  if (value.k === 'expr' && !/SUPPRESS/.test(value.src)) {
    const shown = simpleDefault(value.src)
    return { defaultText: shown, defaultComputed: shown === null }
  }
  return NO_DEFAULT
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

  const { defaultText, defaultComputed } = kind !== 'switch' && kind !== 'count' ? shownDefault(kw.get('default')) : NO_DEFAULT

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
    valueType, choices, defaultText, defaultComputed, metavar, help, writes: false, offFlags: [], defaultOn: false
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

function usageParam(partial: Omit<ScriptParam, 'label' | 'valueType' | 'writes' | 'help' | 'defaultText' | 'defaultComputed' | 'repeat' | 'offFlags' | 'defaultOn'>): ScriptParam {
  const takesValue = partial.kind === 'positional' || partial.kind === 'value'
  const hinted = takesValue && !partial.choices ? typeFromMetavar(partial.metavar) : null
  return {
    ...partial, label: humanise(partial.id), valueType: hinted ?? 'text', writes: false, help: null, defaultText: null, defaultComputed: false, repeat: false,
    offFlags: [], defaultOn: false
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
    for (const flag of [...param.flags, ...param.offFlags]) {
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
 * The params of the script's one argparse parser, in declaration order, or
 * null when it has none. Throws a surprise for anything that could make the form
 * wrong: no parser, two, one not assigned to a name, `parents=`, subparsers,
 * an `add_argument` on anything but the parser or one of its groups, no
 * `parse_args` on it, the parser's or a group's name bound anywhere else
 * (`parser = Fake()`), or more than the reader will look at. A factory —
 * the parser built in `def F(…)` that returns it — may be called: `X = F(…)`
 * starting a logical line makes X the parser too, and `F(…).parse_args(`
 * parses it.
 */
function argparseParams(tokens: PyToken[], source: string): ScriptParam[] | null {
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
  if (parser === null) return calls === 0 ? null : surprise()
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

/* -------------------------------------------------------- click and typer */

/** The most tokens a typer command's signature may hold (each parameter still at most {@link MAX_CALL_TOKENS}). */
const MAX_SIGNATURE_TOKENS = MAX_CALL_TOKENS * 20

const FLAG_NAME = /^--?[A-Za-z0-9][\w.-]*$/

/** A param with every field the form needs, the rest at their plain defaults. */
function makeParam(fields: Partial<ScriptParam> & Pick<ScriptParam, 'id' | 'kind' | 'flags'>): ScriptParam {
  return {
    label: humanise(fields.id), required: false, multiple: false, repeat: false, valueType: 'text', choices: null,
    defaultText: null, defaultComputed: false, metavar: null, help: null, writes: false, offFlags: [], defaultOn: false, ...fields
  }
}

/** A token range's source with its whitespace dropped: what a type or a callee is matched by. */
function compact(tokens: PyToken[], source: string): string {
  return tokens.length === 0 ? '' : source.slice(tokens[0].start, tokens[tokens.length - 1].end).replace(/\s+/g, '')
}

interface CallArgs { positional: PyToken[][]; kw: Map<string, PyToken[]> }

/** A call's arguments as token ranges; `*args`, `**kw`, a repeated keyword or a positional after a keyword is a surprise. */
function callArgs(args: PyToken[]): CallArgs {
  const positional: PyToken[][] = []
  const kw = new Map<string, PyToken[]>()
  for (const arg of splitCommas(args)) {
    if (arg.length === 0) continue
    if (isOp(arg[0], '*')) surprise()
    if (arg.length >= 2 && arg[0].t === 'name' && isOp(arg[1], '=') && !isOp(arg[2], '=')) {
      if (kw.has(arg[0].raw)) surprise()
      kw.set(arg[0].raw, arg.slice(2))
      continue
    }
    if (kw.size > 0) surprise()
    positional.push(arg)
  }
  return { positional, kw }
}

function onlyKeywords(kw: Map<string, PyToken[]>, known: ReadonlySet<string>): void {
  for (const key of kw.keys()) if (!known.has(key)) surprise()
}

/** A keyword that must be a literal bool when given; false when absent. */
function boolKw(kw: Map<string, PyToken[]>, name: string, source: string): boolean {
  const tokens = kw.get(name)
  if (!tokens) return false
  const value = literal(tokens, source)
  return value.k === 'bool' ? value.v : surprise()
}

/** A keyword's literal string, or null (absent, or not a literal). */
function textKw(kw: Map<string, PyToken[]>, name: string, source: string): string | null {
  const tokens = kw.get(name)
  if (!tokens) return null
  const value = literal(tokens, source)
  return value.k === 'str' ? value.v : null
}

const plainHelp = (help: string | null): string | null => {
  const flat = help?.replace(/\s+/g, ' ').trim() ?? ''
  return flat === '' ? null : flat
}

/** A positional argument that must be a non-empty string literal. */
function nameArg(tokens: PyToken[], source: string): string {
  const value = literal(tokens, source)
  return value.k === 'str' && value.v !== '' ? value.v : surprise()
}

/**
 * click's and typer's option names: `--x`, `-x`, `--x/--no-x` (the second
 * half are the off flags) and, for click, one bare identifier naming the
 * parameter. Anything else is a surprise; so is no flag at all.
 */
function optionDecls(names: string[], allowDest: boolean): { dest: string | null; flags: string[]; offFlags: string[] } {
  let dest: string | null = null
  const flags: string[] = []
  const offFlags: string[] = []
  for (const name of names) {
    if (name.includes('/')) {
      const parts = name.split('/').map((part) => part.trim())
      if (parts.length !== 2 || !FLAG_NAME.test(parts[0]) || !FLAG_NAME.test(parts[1])) surprise()
      flags.push(parts[0])
      offFlags.push(parts[1])
      continue
    }
    if (FLAG_NAME.test(name)) { flags.push(name); continue }
    if (allowDest && dest === null && /^[A-Za-z_]\w*$/.test(name)) { dest = name; continue }
    surprise()
  }
  if (flags.length === 0) surprise()
  return { dest, flags, offFlags }
}

/** click's name for an option without one: its first long flag, else its first, lowercased with `-` as `_`. */
function flagDest(flags: string[]): string {
  const flag = flags.find((candidate) => candidate.startsWith('--')) ?? flags[0]
  return flag.replace(/^-+/, '').replace(/-/g, '_').toLowerCase()
}

/** The first token of the logical line before the one `k` starts, or -1. */
function previousLineStart(indents: number[], k: number): number {
  for (let j = k - 1; j >= 0; j--) if (indents[j] !== -1) return j
  return -1
}

interface Decorator { path: string; args: PyToken[] | null; end: number }

/** The decorator whose `@` is token `at`: its dotted name, its call's arguments (null for none), and the token after it. */
function decoratorAt(tokens: PyToken[], indents: number[], at: number): Decorator {
  let k = at + 1
  const parts: string[] = []
  for (;;) {
    const token = tokens[k]
    if (token?.t !== 'name') return surprise()
    parts.push(token.raw)
    k++
    if (!isOp(tokens[k], '.')) break
    if (parts.length >= 4) surprise()
    k++
  }
  let args: PyToken[] | null = null
  if (isOp(tokens[k], '(')) {
    const end = closing(tokens, k, MAX_CALL_TOKENS)
    if (end === -1) surprise()
    args = tokens.slice(k + 1, end)
    k = end + 1
  }
  // Anything after the decorator on its line (`@x(…)(…)`, `@x[0]`) is a shape this reader does not take.
  if (k < tokens.length && indents[k] === -1) surprise()
  return { path: parts.join('.'), args, end: k }
}

/** A `def NAME(` starting a logical line at `k`, or null. */
function defAt(tokens: PyToken[], indents: number[], k: number): { name: string; open: number } | null {
  const head = tokens[k]
  const name = tokens[k + 1]
  if (indents[k] === -1 || head?.t !== 'name' || head.raw !== 'def' || name?.t !== 'name' || !isOp(tokens[k + 2], '(')) return null
  return { name: name.raw, open: k + 2 }
}

/**
 * The command's name (`hello`, `app`) is used only as a command: never bound
 * again (`hello = other`, a second `def hello`), never reached into except by
 * `attrs` (`hello.main(…)`), and, with `mustCall`, called somewhere: the
 * script runs it. `own` is the index of the token that binds it.
 */
function commandNameUses(tokens: PyToken[], depths: number[], source: string, name: string, own: number, attrs: ReadonlySet<string>, mustCall: boolean): void {
  let called = false
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    if (k === own || token.t !== 'name' || token.raw !== name || isOp(tokens[k - 1], '.')) continue
    if (isOp(tokens[k + 1], '(')) { called = true; continue }
    if (isOp(tokens[k + 1], '.')) {
      const attr = tokens[k + 2]
      if (attr?.t !== 'name' || !attrs.has(attr.raw)) return surprise()
      // `cli.main(…)` runs the command as `cli()` does.
      if (attr.raw === 'main' && isOp(tokens[k + 3], '(')) called = true
      continue
    }
    if (bindsName(tokens, depths, k, source)) surprise()
  }
  if (mustCall && !called) surprise()
}

/** A type's form field: its value type and choices. `bool` and tuple types are surprises; an unknown type reads as text, as argparse's does. */
function clickType(tokens: PyToken[] | undefined, source: string): { base: ScriptValueType; choices: string[] | null } {
  const plain = { base: 'text' as ScriptValueType, choices: null }
  if (!tokens || tokens.length === 0) return plain
  const src = compact(tokens, source)
  if (/^(int|click\.INT)$/.test(src) || /^click\.IntRange\(/.test(src)) return { base: 'int', choices: null }
  if (/^(float|click\.FLOAT)$/.test(src) || /^click\.FloatRange\(/.test(src)) return { base: 'float', choices: null }
  if (/^click\.(Path|File)(\(|$)/.test(src) || /^(pathlib\.)?Path$/.test(src)) return { base: 'path', choices: null }
  if (/^click\.DateTime(\(\))?$/.test(src)) return { base: 'date', choices: null }
  if (/^click\.Choice\(/.test(src)) {
    if (!isOp(tokens[3], '(') || closing(tokens, 3) !== tokens.length - 1) surprise()
    const { positional, kw } = callArgs(tokens.slice(4, -1))
    onlyKeywords(kw, new Set(['case_sensitive']))
    boolKw(kw, 'case_sensitive', source)
    if (positional.length !== 1) surprise()
    const value = literal(positional[0], source)
    if (value.k !== 'seq') surprise()
    const listed = (value as { items: PyValue[] }).items.map(text)
    if (listed.length === 0 || !listed.every((item): item is string => item !== null)) surprise()
    return { base: 'text', choices: listed as string[] }
  }
  if (/^(bool|click\.BOOL)$/.test(src) || tokens[0].t === 'op') surprise()
  return plain
}

const CLICK_COMMAND_KEYWORDS = new Set(['name', 'help', 'short_help', 'epilog', 'no_args_is_help', 'hidden', 'deprecated', 'add_help_option', 'options_metavar'])
const CLICK_OPTION_KEYWORDS = new Set([
  'type', 'default', 'required', 'help', 'is_flag', 'multiple', 'count', 'metavar', 'show_default', 'prompt', 'hide_input',
  'confirmation_prompt', 'prompt_required', 'hidden', 'nargs', 'envvar', 'show_envvar', 'show_choices'
])
const CLICK_ARGUMENT_KEYWORDS = new Set(['type', 'required', 'nargs', 'default', 'metavar', 'envvar'])
/** click names that build a CLI this reader does not take: groups, commands or params built by hand, prompts as options. */
const CLICK_REFUSED = new Set(['group', 'Group', 'Command', 'MultiCommand', 'CommandCollection', 'BaseCommand', 'Option', 'Argument', 'Parameter', 'password_option', 'confirmation_option', 'make_pass_decorator'])
/** click decorators: each must sit in the one command's stack. */
const CLICK_DECORATORS = new Set(['command', 'option', 'argument', 'version_option', 'help_option', 'pass_context', 'pass_obj'])

/** A literal integer `nargs`, or a surprise. */
function nargsOf(kw: Map<string, PyToken[]>, source: string): number {
  const tokens = kw.get('nargs')
  if (!tokens) return 1
  const value = literal(tokens, source)
  const n = value.k === 'num' ? Number(value.v) : NaN
  return Number.isInteger(n) ? n : surprise()
}

/** One `@click.option(…)`: a parameter, or 'skip' for a hidden one. */
function clickOption(args: PyToken[], source: string): ScriptParam | 'skip' {
  const { positional, kw } = callArgs(args)
  onlyKeywords(kw, CLICK_OPTION_KEYWORDS)
  const { dest, flags, offFlags } = optionDecls(positional.map((arg) => nameArg(arg, source)), true)
  if (boolKw(kw, 'hidden', source)) return 'skip'
  const id = dest ?? flagDest(flags)
  if (!/^[A-Za-z_]\w*$/.test(id)) surprise()
  const isFlag = kw.has('is_flag') ? boolKw(kw, 'is_flag', source) : null
  const count = boolKw(kw, 'count', source)
  const multiple = boolKw(kw, 'multiple', source)
  const required = boolKw(kw, 'required', source)
  const defaultValue = kw.has('default') ? literal(kw.get('default')!, source) : undefined
  const help = plainHelp(textKw(kw, 'help', source))
  const metavar = textKw(kw, 'metavar', source)

  if (offFlags.length > 0 || isFlag === true) {
    if (isFlag === false || count || multiple || kw.has('nargs') || kw.has('type')) surprise()
    if (defaultValue !== undefined && defaultValue.k !== 'bool') surprise()
    const defaultOn = defaultValue?.k === 'bool' && defaultValue.v
    // `is_flag=True, default=True` with no off flag: click makes the flag turn it off, which no switch can show.
    if (defaultOn && offFlags.length === 0) surprise()
    return makeParam({ id, kind: 'switch', flags, offFlags, defaultOn, help })
  }
  if (count) {
    if (multiple || kw.has('nargs') || kw.has('type')) surprise()
    return makeParam({ id, kind: 'count', flags, help })
  }
  const nargs = nargsOf(kw, source)
  if (nargs < 1 || (nargs > 1 && multiple)) surprise()
  const { base, choices } = clickType(kw.get('type'), source)
  return makeParam({
    id, kind: 'value', flags, required, multiple: multiple || nargs > 1, repeat: multiple, choices, metavar, help,
    valueType: refineType(base, id, metavar, help), ...shownDefault(defaultValue)
  })
}

/** One `@click.argument(…)`: a positional. */
function clickArgument(args: PyToken[], source: string): ScriptParam {
  const { positional, kw } = callArgs(args)
  onlyKeywords(kw, CLICK_ARGUMENT_KEYWORDS)
  if (positional.length !== 1) surprise()
  const name = nameArg(positional[0], source)
  if (!/^[A-Za-z_][\w-]*$/.test(name)) surprise()
  const id = name.replace(/-/g, '_').toLowerCase()
  const nargs = nargsOf(kw, source)
  if (nargs === 0 || nargs < -1) surprise()
  const defaultValue = kw.has('default') ? literal(kw.get('default')!, source) : undefined
  const required = kw.has('required') ? boolKw(kw, 'required', source) : nargs !== -1 && defaultValue === undefined
  const metavar = textKw(kw, 'metavar', source)
  const { base, choices } = clickType(kw.get('type'), source)
  return makeParam({
    id, kind: 'positional', flags: [], required, multiple: nargs === -1 || nargs > 1, choices, metavar,
    valueType: refineType(base, id, metavar, null), ...shownDefault(defaultValue)
  })
}

/** A command's own decorator arguments: at most a literal name, and only the keywords that change no parameter. */
function commandDecoratorArgs(args: PyToken[] | null, known: ReadonlySet<string>, source: string): void {
  if (!args) return
  const { positional, kw } = callArgs(args)
  onlyKeywords(kw, known)
  if (positional.length > 1) surprise()
  if (positional.length === 1) nameArg(positional[0], source)
}

/** A decorator on anything that builds a subcommand or a group callback: `@cli.command()`, `@app.callback()`. */
function groupDecorators(tokens: PyToken[], indents: number[], allowed: string | null): void {
  for (let k = 0; k < tokens.length; k++) {
    if (!isOp(tokens[k], '@') || indents[k] === -1) continue
    const owner = tokens[k + 1]
    const member = tokens[k + 3]
    if (owner?.t !== 'name' || !isOp(tokens[k + 2], '.') || member?.t !== 'name') continue
    if (!['command', 'group', 'callback', 'result_callback'].includes(member.raw)) continue
    if (owner.raw === 'click' || (owner.raw === allowed && member.raw === 'command')) continue
    surprise()
  }
}

/**
 * The params of the script's one click command, in declaration order, or
 * null when it uses no click decorator. A surprise for anything else: a
 * group, a second command, a click decorator not in the command's stack (or
 * above it), a decorator in the stack that is not click's, the stack on
 * something other than a `def`, the command never called or its name bound
 * again.
 */
function clickParams(tokens: PyToken[], source: string, depths: number[], indents: number[]): ScriptParam[] | null {
  let decorators = 0
  let command = -1
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    if (token.t !== 'name' || token.raw !== 'click' || !isOp(tokens[k + 1], '.') || isOp(tokens[k - 1], '.')) continue
    const member = tokens[k + 2]
    if (member?.t !== 'name') continue
    if (CLICK_REFUSED.has(member.raw)) surprise()
    if (!CLICK_DECORATORS.has(member.raw)) continue
    if (!isOp(tokens[k - 1], '@') || indents[k - 1] === -1 || isOp(tokens[k + 3], '.')) surprise()
    if (++decorators > MAX_ADD_ARGUMENT_CALLS) surprise()
    if (member.raw === 'command') {
      if (command !== -1) surprise()
      command = k - 1
    }
  }
  if (decorators === 0) return null
  if (command === -1) surprise()
  const above = previousLineStart(indents, command)
  if (above !== -1 && isOp(tokens[above], '@')) surprise()
  const head = decoratorAt(tokens, indents, command)
  commandDecoratorArgs(head.args, CLICK_COMMAND_KEYWORDS, source)

  const params: ScriptParam[] = []
  let seen = 1
  let at = head.end
  while (isOp(tokens[at], '@') && indents[at] !== -1) {
    const decorator = decoratorAt(tokens, indents, at)
    const what = decorator.path.startsWith('click.') ? decorator.path.slice('click.'.length) : ''
    if (what === 'option' || what === 'argument') {
      if (decorator.args === null) surprise()
      const param = what === 'option' ? clickOption(decorator.args!, source) : clickArgument(decorator.args!, source)
      if (param !== 'skip') params.push(param)
    } else if (!['version_option', 'help_option', 'pass_context', 'pass_obj'].includes(what)) {
      surprise()
    }
    seen++
    at = decorator.end
  }
  if (seen !== decorators) surprise()
  const def = defAt(tokens, indents, at)
  if (!def) return surprise()
  groupDecorators(tokens, indents, null)
  commandNameUses(tokens, depths, source, def.name, at + 1, new Set(['main']), true)
  return params
}

type TyperBase = ScriptValueType | 'bool' | 'context'
interface TyperType { base: TyperBase; list: boolean; optional: boolean; info: PyToken[] | null }

/** A `typer.Option(…)` / `typer.Argument(…)` call spanning exactly `tokens`, or null. */
function typerCall(tokens: PyToken[]): { which: 'Option' | 'Argument'; args: PyToken[] } | null {
  const [mod, dot, name, open] = tokens
  if (mod?.t !== 'name' || mod.raw !== 'typer' || !isOp(dot, '.') || name?.t !== 'name' || !isOp(open, '(')) return null
  if (name.raw !== 'Option' && name.raw !== 'Argument') return null
  if (closing(tokens, 3) !== tokens.length - 1) return null
  return { which: name.raw, args: tokens.slice(4, -1) }
}

/** Split a token range at its top-level `sep` operators. */
function splitTop(tokens: PyToken[], sep: string): PyToken[][] {
  const parts: PyToken[][] = [[]]
  let depth = 0
  for (const token of tokens) {
    if (token.t === 'op') {
      if (OPEN[token.raw]) depth++
      else if (token.raw === ')' || token.raw === ']' || token.raw === '}') depth--
      else if (token.raw === sep && depth === 0) { parts.push([]); continue }
    }
    parts[parts.length - 1].push(token)
  }
  return parts
}

const isNone = (tokens: PyToken[]): boolean => tokens.length === 1 && tokens[0].t === 'name' && tokens[0].raw === 'None'

const TYPER_SCALARS: Record<string, TyperBase> = {
  str: 'text', int: 'int', float: 'float', bool: 'bool', Path: 'path', 'pathlib.Path': 'path',
  datetime: 'date', 'datetime.datetime': 'date'
}

/**
 * A typer parameter's annotation: `str`, `int`, `float`, `bool`, `Path`,
 * `datetime`, `Optional[X]` / `X | None`, `List[X]`, `typer.Context`, and at
 * the top `Annotated[X, typer.Option(…) | typer.Argument(…)]`. Anything else
 * (an Enum, `Literal`, a string annotation) is a surprise.
 */
function typerAnnotation(tokens: PyToken[], source: string, top: boolean, depth = 0): TyperType {
  if (depth > 4) surprise()
  if (tokens.length === 0) return { base: 'text', list: false, optional: false, info: null }
  const union = splitTop(tokens, '|')
  if (union.length > 1) {
    const kept = union.filter((part) => !isNone(part))
    if (kept.length !== 1 || kept.length === union.length) surprise()
    return { ...typerAnnotation(kept[0], source, false, depth + 1), optional: true }
  }
  const bracket = tokens.findIndex((token) => isOp(token, '['))
  if (bracket === -1) {
    const name = compact(tokens, source)
    if (top && (name === 'typer.Context' || name === 'Context')) return { base: 'context', list: false, optional: false, info: null }
    const base = Object.prototype.hasOwnProperty.call(TYPER_SCALARS, name) ? TYPER_SCALARS[name] : surprise()
    return { base, list: false, optional: false, info: null }
  }
  if (bracket === 0 || closing(tokens, bracket) !== tokens.length - 1) surprise()
  const head = compact(tokens.slice(0, bracket), source)
  const inner = splitCommas(tokens.slice(bracket + 1, -1))
  if (top && /^((typing|typing_extensions)\.)?Annotated$/.test(head)) {
    if (inner.length < 2) surprise()
    const calls = inner.slice(1)
    if (calls.length !== 1 || typerCall(calls[0]) === null) surprise()
    return { ...typerAnnotation(inner[0], source, false, depth + 1), info: calls[0] }
  }
  if (/^(typing\.)?Optional$/.test(head)) {
    if (inner.length !== 1) surprise()
    return { ...typerAnnotation(inner[0], source, false, depth + 1), optional: true }
  }
  if (/^(typing\.)?Union$/.test(head)) {
    const kept = inner.filter((part) => !isNone(part))
    if (kept.length !== 1 || kept.length === inner.length) surprise()
    return { ...typerAnnotation(kept[0], source, false, depth + 1), optional: true }
  }
  if (/^((typing\.)?List|list)$/.test(head)) {
    if (inner.length !== 1) surprise()
    const item = typerAnnotation(inner[0], source, false, depth + 1)
    if (item.list || item.base === 'bool' || item.optional) surprise()
    return { ...item, list: true }
  }
  return surprise()
}

const TYPER_APP_KEYWORDS = new Set([
  'help', 'add_completion', 'no_args_is_help', 'rich_markup_mode', 'pretty_exceptions_enable', 'pretty_exceptions_show_locals',
  'pretty_exceptions_short', 'name', 'epilog', 'short_help'
])
const TYPER_COMMAND_KEYWORDS = new Set(['name', 'help', 'short_help', 'epilog', 'no_args_is_help', 'hidden', 'deprecated', 'rich_help_panel', 'options_metavar', 'add_help_option'])
const TYPER_PARAM_KEYWORDS = new Set([
  'default', 'help', 'show_default', 'metavar', 'hidden', 'case_sensitive', 'min', 'max', 'clamp', 'prompt', 'confirmation_prompt',
  'hide_input', 'prompt_required', 'envvar', 'show_envvar', 'rich_help_panel', 'count', 'exists', 'file_okay', 'dir_okay', 'writable',
  'readable', 'resolve_path', 'allow_dash', 'formats', 'show_choices', 'path_type'
])

const isEllipsis = (tokens: PyToken[]): boolean =>
  tokens.length === 3 && tokens.every((token) => isOp(token, '.')) && tokens[1].start === tokens[0].end && tokens[2].start === tokens[1].end

/**
 * One parameter of the typer command's signature: a parameter, or null for
 * a `typer.Context` or a hidden one; `uses` counts the `typer.Option` /
 * `typer.Argument` calls it holds.
 */
function typerParam(part: PyToken[], source: string): { param: ScriptParam | null; uses: number } {
  if (part.length > MAX_CALL_TOKENS) surprise()
  const head = part[0]
  if (head?.t !== 'name' || head.raw === 'self' || head.raw === 'cls') surprise()
  const name = (head as { raw: string }).raw
  let annotation: PyToken[] = []
  let assigned: PyToken[] | null = null
  if (isOp(part[1], ':')) {
    let depth = 0
    let j = 2
    for (; j < part.length; j++) {
      const token = part[j]
      if (token.t !== 'op') continue
      if (OPEN[token.raw]) depth++
      else if (token.raw === ')' || token.raw === ']' || token.raw === '}') depth--
      else if (token.raw === '=' && depth === 0) break
    }
    annotation = part.slice(2, j)
    if (annotation.length === 0) surprise()
    if (j < part.length) assigned = part.slice(j + 1)
  } else if (isOp(part[1], '=')) {
    assigned = part.slice(2)
  } else if (part.length !== 1) {
    surprise()
  }
  if (assigned !== null && assigned.length === 0) surprise()

  const type = typerAnnotation(annotation, source, true)
  if (type.base === 'context') {
    if (assigned !== null) surprise()
    return { param: null, uses: 0 }
  }
  let info = type.info ? typerCall(type.info) : null
  let uses = info ? 1 : 0
  let defaultTokens: PyToken[] | null = assigned
  let decls: PyToken[][] = []
  let kw = new Map<string, PyToken[]>()
  const fromDefault = assigned ? typerCall(assigned) : null
  if (fromDefault) {
    // The older style: `= typer.Option(default, "--name", …)`.
    if (info) surprise()
    info = fromDefault
    uses++
    const args = callArgs(info.args)
    kw = args.kw
    if (args.positional.length > 0 && kw.has('default')) surprise()
    defaultTokens = args.positional[0] ?? kw.get('default') ?? null
    decls = args.positional.slice(1)
  } else if (info) {
    // `Annotated[T, typer.Option("--name", …)] = default`.
    const args = callArgs(info.args)
    kw = args.kw
    if (kw.has('default')) surprise()
    decls = args.positional
  }
  onlyKeywords(kw, TYPER_PARAM_KEYWORDS)
  if (boolKw(kw, 'hidden', source)) return { param: null, uses }
  const required = defaultTokens === null || isEllipsis(defaultTokens)
  const defaultValue = required ? undefined : literal(defaultTokens!, source)
  const help = plainHelp(textKw(kw, 'help', source))
  const metavar = textKw(kw, 'metavar', source)
  const which = info?.which ?? (assigned === null ? 'Argument' : 'Option')
  const base = type.base as ScriptValueType | 'bool'

  if (which === 'Argument') {
    if (decls.length > 0 || base === 'bool' || kw.has('count')) surprise()
    return {
      param: makeParam({
        id: name, kind: 'positional', flags: [], required, multiple: type.list, metavar, help,
        valueType: refineType(base as ScriptValueType, name, metavar, help), ...shownDefault(defaultValue)
      }),
      uses
    }
  }
  let flags: string[]
  let offFlags: string[]
  if (decls.length > 0) {
    ;({ flags, offFlags } = optionDecls(decls.map((decl) => nameArg(decl, source)), false))
  } else {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) surprise()
    const flag = name.replace(/_/g, '-')
    flags = [`--${flag}`]
    offFlags = base === 'bool' ? [`--no-${flag}`] : []
  }
  const count = boolKw(kw, 'count', source)
  if (base === 'bool') {
    if (type.list || type.optional || count || required || defaultValue?.k !== 'bool') surprise()
    const defaultOn = (defaultValue as { v: boolean }).v
    // `--force` alone with a True default: typer's flag would turn it off, which no switch can show.
    if (defaultOn && offFlags.length === 0) surprise()
    return { param: makeParam({ id: name, kind: 'switch', flags, offFlags, defaultOn, help }), uses }
  }
  if (offFlags.length > 0) surprise()
  if (count) {
    if (base !== 'int' || type.list) surprise()
    return { param: makeParam({ id: name, kind: 'count', flags, help }), uses }
  }
  return {
    param: makeParam({
      id: name, kind: 'value', flags, required, multiple: type.list, repeat: type.list, metavar, help,
      valueType: refineType(base, name, metavar, help), ...shownDefault(defaultValue)
    }),
    uses
  }
}

/**
 * The params of the script's one typer command, in signature order, or null
 * when it uses neither `typer.run` nor `typer.Typer`. The command is
 * `typer.run(F)` on an undecorated `def F`, or one `app = typer.Typer(…)`
 * with exactly one `@app.command(…)` directly on a `def` and `app(…)`
 * called. A surprise for both forms at once, a second command,
 * `@app.callback`, `app.add_typer`, any other use of the app, another
 * decorator on the command, `*args` / `**kwargs`, an annotation it does not
 * read, a `typer.Option` / `typer.Argument` outside the signature (a shared
 * one), or the command's names bound again.
 */
function typerParams(tokens: PyToken[], source: string, depths: number[], indents: number[]): ScriptParam[] | null {
  let run = -1
  let app: { name: string; target: number } | null = null
  let uses = 0
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    if (token.t !== 'name' || token.raw !== 'typer' || !isOp(tokens[k + 1], '.') || isOp(tokens[k - 1], '.')) continue
    const member = tokens[k + 2]
    if (member?.t !== 'name') continue
    if (member.raw === 'main') surprise()
    if (member.raw === 'Option' || member.raw === 'Argument') {
      if (++uses > MAX_ADD_ARGUMENT_CALLS) surprise()
      continue
    }
    if (member.raw !== 'run' && member.raw !== 'Typer') continue
    if (!isOp(tokens[k + 3], '(') || run !== -1 || app !== null) surprise()
    if (member.raw === 'run') { run = k + 2; continue }
    const assigned = assignedName(tokens, depths, k + 2, source)
    if (assigned === null) return surprise()
    const end = closing(tokens, k + 3, MAX_CALL_TOKENS)
    if (end === -1) surprise()
    const { positional, kw } = callArgs(tokens.slice(k + 4, end))
    if (positional.length > 0) surprise()
    onlyKeywords(kw, TYPER_APP_KEYWORDS)
    app = assigned
  }
  if (run === -1 && app === null) return uses === 0 ? null : surprise()

  let defIndex: number
  if (run !== -1) {
    const open = run + 1
    const end = closing(tokens, open, MAX_CALL_TOKENS)
    const fn = tokens[open + 1]
    if (end !== open + 2 || fn.t !== 'name') return surprise()
    const defs: number[] = []
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k]
      const next = tokens[k + 1]
      if (token.t === 'name' && token.raw === 'def' && next?.t === 'name' && next.raw === fn.raw) defs.push(k)
    }
    if (defs.length !== 1 || !defAt(tokens, indents, defs[0])) surprise()
    defIndex = defs[0]
    const above = previousLineStart(indents, defIndex)
    if (above !== -1 && isOp(tokens[above], '@')) surprise()
    commandNameUses(tokens, depths, source, fn.raw, defIndex + 1, new Set(), false)
    groupDecorators(tokens, indents, null)
  } else {
    const { name, target } = app!
    let command = -1
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k]
      if (k === target || token.t !== 'name' || token.raw !== name || isOp(tokens[k - 1], '.') || !isOp(tokens[k + 1], '.')) continue
      const member = tokens[k + 2]
      if (member?.t !== 'name' || member.raw !== 'command' || !isOp(tokens[k - 1], '@') || indents[k - 1] === -1 || command !== -1) surprise()
      command = k - 1
    }
    if (command === -1) surprise()
    commandNameUses(tokens, depths, source, name, target, new Set(['command']), true)
    groupDecorators(tokens, indents, name)
    const above = previousLineStart(indents, command)
    if (above !== -1 && isOp(tokens[above], '@')) surprise()
    const decorator = decoratorAt(tokens, indents, command)
    commandDecoratorArgs(decorator.args, TYPER_COMMAND_KEYWORDS, source)
    const def = defAt(tokens, indents, decorator.end)
    if (!def) return surprise()
    defIndex = decorator.end
    commandNameUses(tokens, depths, source, def.name, defIndex + 1, new Set(), false)
  }

  const open = defIndex + 2
  const close = closing(tokens, open, MAX_SIGNATURE_TOKENS)
  if (close === -1) surprise()
  const parts = splitCommas(tokens.slice(open + 1, close))
  if (parts.length > MAX_ADD_ARGUMENT_CALLS) surprise()
  const params: ScriptParam[] = []
  let used = 0
  for (const part of parts) {
    if (part.length === 0) continue
    const { param, uses: held } = typerParam(part, source)
    used += held
    if (param) params.push(param)
  }
  if (used !== uses) surprise()
  return params
}

/**
 * `from click import …` / `from typer import …` of a name that builds a CLI,
 * or `import click as c`: the command would be built under a name this
 * reader does not follow.
 */
function aliasedFrameworks(tokens: PyToken[], indents: number[]): void {
  const CLI_NAMES = new Set(['command', 'group', 'option', 'argument', 'Command', 'Group', 'Option', 'Argument', 'version_option', 'help_option', 'Typer', 'run', '*'])
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    if (token.t !== 'name') continue
    if (token.raw === 'from') {
      const mod = tokens[k + 1]
      if (mod?.t !== 'name' || (mod.raw !== 'click' && mod.raw !== 'typer')) continue
      if (!isOp(tokens[k + 2], '.') && !(tokens[k + 2]?.t === 'name' && (tokens[k + 2] as { raw: string }).raw === 'import')) continue
      for (let j = k + 2; j < tokens.length && (j === k + 2 || indents[j] === -1); j++) {
        const name = tokens[j]
        if (j - k > MAX_CALL_TOKENS) surprise()
        if ((name.t === 'name' || name.t === 'op') && CLI_NAMES.has(name.raw)) surprise()
      }
      continue
    }
    if (token.raw !== 'import') continue
    for (let j = k + 1; j < tokens.length && (j === k + 1 || indents[j] === -1); j++) {
      if (j - k > MAX_CALL_TOKENS) break
      const name = tokens[j]
      if (name.t !== 'name' || (name.raw !== 'click' && name.raw !== 'typer') || isOp(tokens[j - 1], '.')) continue
      const after = tokens[j + 1]
      if (after?.t === 'name' && after.raw === 'as') surprise()
    }
  }
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

    // One framework speaks, or none: argparse, click or typer. Two at once is a surprise.
    const depths = bracketDepths(tokens)
    const indents = lineIndents(tokens, depths, source)
    aliasedFrameworks(tokens, indents)
    const spoke = [argparseParams(tokens, source), clickParams(tokens, source, depths, indents), typerParams(tokens, source, depths, indents)]
      .filter((params): params is ScriptParam[] => params !== null)
    if (spoke.length > 1) surprise()
    const fromCalls = spoke[0] ?? []
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

/* --------------------------------------------------------- shell getopts */

type ShWord = { t: 'word'; raw: string; value: string; plain: boolean; expands: boolean }
type ShToken = ShWord | { t: 'op'; raw: string } | { t: 'nl' }

/** Shell operators, longest first. */
const SH_OPS = [';;&', ';;', ';&', '&&', '||', '|&', '<<-', '<<<', '<<', '>>', '>&', '<&', '&>', '<>', '>|', ';', '|', '&', '(', ')', '<', '>']

/** Where the quote opened at `at` closes (`'` plain, `"` with backslash escapes), or a surprise. */
function shellQuoteEnd(source: string, at: number): number {
  const quote = source[at]
  for (let j = at + 1; j < source.length; j++) {
    if (quote === '"' && source[j] === '\\') { j++; continue }
    if (source[j] === quote) return j
  }
  return surprise()
}

/** Where the `$(…)` / `${…}` / backtick substitution starting at `at` ends, quotes inside skipped; a surprise when it does not. */
function substitutionEnd(source: string, at: number): number {
  if (source[at] === '`') {
    const end = source.indexOf('`', at + 1)
    return end === -1 ? surprise() : end
  }
  const open = source[at + 1]
  const close = open === '(' ? ')' : '}'
  let depth = 0
  for (let j = at + 1; j < source.length; j++) {
    const ch = source[j]
    if (ch === '\\') { j++; continue }
    if (ch === "'" || ch === '"') { j = shellQuoteEnd(source, j); continue }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return j
  }
  return surprise()
}

/**
 * Words, operators and line breaks of a shell script, enough to find a
 * `getopts` loop: quotes, escapes and substitutions kept inside their word,
 * comments dropped, here-document bodies skipped. An unterminated quote,
 * substitution or here-document is a surprise. One pass: linear.
 */
function lexShell(source: string): ShToken[] {
  const tokens: ShToken[] = []
  const n = source.length
  const heredocs: { delim: string; strip: boolean }[] = []
  let delimNext: boolean | null = null
  let i = 0
  while (i < n) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }
    if (ch === '\\' && source[i + 1] === '\n') { i += 2; continue }
    if (ch === '\n') {
      tokens.push({ t: 'nl' })
      i++
      for (const doc of heredocs) {
        for (;;) {
          if (i >= n) surprise()
          const found = source.indexOf('\n', i)
          const end = found === -1 ? n : found
          const line = source.slice(i, end).replace(/\r$/, '')
          i = end + 1
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break
        }
      }
      heredocs.length = 0
      continue
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    const op = SH_OPS.find((candidate) => source.startsWith(candidate, i))
    if (op) {
      tokens.push({ t: 'op', raw: op })
      i += op.length
      if (op === '<<' || op === '<<-') delimNext = op === '<<-'
      continue
    }
    const start = i
    let value = ''
    let plain = true
    let expands = false
    while (i < n) {
      const c = source[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || ';&|()<>'.includes(c)) break
      if (c === "'" || c === '"') {
        const end = shellQuoteEnd(source, i)
        const body = source.slice(i + 1, end)
        if (c === '"' && /[$`]/.test(body)) expands = true
        value += c === '"' ? body.replace(/\\([$`"\\\n])/g, '$1') : body
        plain = false
        i = end + 1
        continue
      }
      if (c === '\\') {
        if (i + 1 >= n) surprise()
        value += source[i + 1]
        plain = false
        i += 2
        continue
      }
      if (c === '`' || (c === '$' && (source[i + 1] === '(' || source[i + 1] === '{'))) {
        const end = substitutionEnd(source, i)
        value += source.slice(i, end + 1)
        plain = false
        expands = true
        i = end + 1
        continue
      }
      if (c === '$') { plain = false; expands = true }
      value += c
      i++
    }
    if (i === start) { i++; continue }
    tokens.push({ t: 'word', raw: source.slice(start, i), value, plain, expands })
    if (delimNext !== null) {
      heredocs.push({ delim: value, strip: delimNext })
      delimNext = null
    }
  }
  return tokens
}

interface Getopt {
  letter: string
  /** `b:` in the optstring: the option takes a value. */
  value: boolean
  /** The variable its arm assigns first (`v) verbose=1 ;;`), if any. */
  variable: string | null
  /** Its arm runs `exit` (a help or version switch). */
  exits: boolean
}

const isWord = (token: ShToken | undefined, value: string): boolean => token?.t === 'word' && token.plain && token.value === value
const isShOp = (token: ShToken | undefined, raw: string): boolean => token?.t === 'op' && token.raw === raw

/** A word that reads or moves the script's arguments: `$1`–`$9`, `${1…}`, `$@`, `$*`, `${@…}`, `${*…}`. */
const READS_ARGS = /\$(?:[1-9@*]|\{[1-9@*])/

/**
 * A surprise when the script's own code before the getopts loop (`end`)
 * reads or moves its arguments — `action=$1; shift`, `set -- …`, `"$@"` —
 * so getopts does not see them from the first: an options-first form
 * (`./s.sh -v deploy`) would then break the script. Function bodies
 * (`name() { … }`, `function name { … }`) are skipped: their `$1` is their
 * own, and a call before the loop is not followed (accepted residual).
 */
function argsReadBefore(tokens: ShToken[], end: number): void {
  let body = 0
  let pending = false
  for (let k = 0; k < end; k++) {
    const token = tokens[k]
    if (token.t === 'op') {
      if (token.raw === '(' && isShOp(tokens[k + 1], ')') && tokens[k - 1]?.t === 'word') pending = true
      continue
    }
    if (token.t !== 'word') continue
    if (token.plain && token.value === 'function' && body === 0) { pending = true; continue }
    if (token.plain && token.value === '{') {
      if (body > 0 || pending) body++
      pending = false
      continue
    }
    if (token.plain && token.value === '}' && body > 0) { body--; continue }
    if (body > 0) continue
    if (token.plain && token.value === 'shift') surprise()
    if (token.plain && token.value === 'set' && isWord(tokens[k + 1], '--')) surprise()
    if (READS_ARGS.test(token.raw)) surprise()
  }
}

/**
 * The options of the script's one `while getopts "<optstring>" <var>` loop,
 * read with its `case "$var" in … esac` (the loop body's only command): null
 * when the script has no `getopts` word. A surprise for a second `getopts`,
 * an optstring that is not a literal (`"$OPTS"`), a duplicate letter, a
 * `case` on anything else, an arm pattern that is not a letter, `\?`, `:`,
 * `*` or `?`, a letter arm the optstring does not have or that comes after a
 * catch-all, a letter in two arms, a fall-through (`;&`), or an optstring
 * letter with no arm of its own — its handling would be the catch-all's,
 * which this reader cannot tell.
 */
function getoptsLetters(tokens: ShToken[]): Getopt[] | null {
  let at = -1
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    if (token.t !== 'word' || token.value !== 'getopts') continue
    if (!token.plain || at !== -1) surprise()
    at = k
  }
  if (at === -1) return null
  argsReadBefore(tokens, at)
  const optstring = tokens[at + 1]
  const variable = tokens[at + 2]
  if (!isWord(tokens[at - 1], 'while') || optstring?.t !== 'word' || optstring.expands || variable?.t !== 'word' || !variable.plain) return surprise()
  if (!/^:?(?:[A-Za-z0-9]:?)+$/.test(optstring.value) || !/^[A-Za-z_]\w*$/.test(variable.value)) surprise()
  const letters = new Map<string, Getopt>()
  const spec = optstring.value.replace(/^:/, '')
  for (let i = 0; i < spec.length; i++) {
    const letter = spec[i]
    if (letter === ':') continue
    if (letters.has(letter)) surprise()
    letters.set(letter, { letter, value: spec[i + 1] === ':', variable: null, exits: false })
  }

  let k = at + 3
  const rest = tokens[k]
  if (rest?.t === 'word' && (rest.raw === '"$@"' || rest.raw === '$@')) k++
  const skipBreaks = (): void => { while (tokens[k]?.t === 'nl' || isShOp(tokens[k], ';')) k++ }
  if (tokens[k]?.t !== 'nl' && !isShOp(tokens[k], ';')) surprise()
  skipBreaks()
  if (!isWord(tokens[k++], 'do')) surprise()
  skipBreaks()
  if (!isWord(tokens[k++], 'case')) surprise()
  const subject = tokens[k++]
  const name = variable.value
  if (subject?.t !== 'word' || ![`$${name}`, `"$${name}"`, `\${${name}}`, `"\${${name}}"`].includes(subject.raw)) surprise()
  if (!isWord(tokens[k++], 'in')) surprise()

  const armed = new Set<string>()
  let catchAll = false
  for (;;) {
    while (tokens[k]?.t === 'nl') k++
    if (k >= tokens.length) surprise()
    if (isWord(tokens[k], 'esac')) { k++; break }
    if (isShOp(tokens[k], '(')) k++
    const patterns: ShWord[] = []
    for (;;) {
      const word = tokens[k++]
      if (word?.t !== 'word' || word.expands) return surprise()
      patterns.push(word)
      if (isShOp(tokens[k], '|')) { k++; continue }
      if (isShOp(tokens[k], ')')) { k++; break }
      surprise()
    }
    // The arm's body: to its `;;`, or to the `esac` that closes the case. A nested case's arms are its own.
    let depth = 0
    let first: ShWord | null = null
    let exits = false
    let last = false
    for (;;) {
      const token = tokens[k]
      if (!token) return surprise()
      if (token.t === 'op' && depth === 0 && token.raw === ';;') { k++; break }
      if (token.t === 'op' && depth === 0 && (token.raw === ';&' || token.raw === ';;&')) surprise()
      if (token.t === 'word' && token.plain) {
        if (token.value === 'case') depth++
        else if (token.value === 'esac') {
          if (depth === 0) { last = true; break }
          depth--
        } else if (token.value === 'exit') exits = true
      }
      if (first === null && token.t === 'word') first = token
      k++
    }
    const assigns = first ? /^([A-Za-z_]\w*)=/.exec(first.raw)?.[1] ?? null : null
    for (const pattern of patterns) {
      if (/^[A-Za-z0-9]$/.test(pattern.value)) {
        const getopt = letters.get(pattern.value)
        if (!getopt || armed.has(pattern.value) || catchAll) return surprise()
        armed.add(pattern.value)
        getopt.variable = assigns
        getopt.exits = exits
      } else if (pattern.plain && (pattern.value === '*' || pattern.value === '?')) {
        catchAll = true
      } else if (pattern.value !== '?' && pattern.value !== ':') {
        surprise()
      }
    }
    if (last) { k++; break }
  }
  while (tokens[k]?.t === 'nl' || isShOp(tokens[k], ';')) k++
  if (!isWord(tokens[k], 'done')) surprise()
  if (armed.size !== letters.size) surprise()
  return [...letters.values()]
}

/**
 * A `getopts` script's params. **getopts decides the flag set; the `# Usage:`
 * header names and explains it.** A header option is kept with only its
 * short flags (a long alias getopts cannot read is dropped) and must agree
 * with getopts: a header option with no short flag getopts knows, a short
 * flag it does not know, or a switch/value disagreement is a surprise (fail
 * closed — the script reads it somewhere this reader does not look). An
 * optstring letter the header does not name is still shown, labelled by the
 * variable its arm sets, else by its flag. A switch whose arm exits (`-h`,
 * `-V`) is left out, as argparse's help is. Positionals come from the header
 * only.
 */
function getoptsParams(getopts: Getopt[], header: string | null, script: string): { params: ScriptParam[]; usage: string[] } {
  const usage = header ? usageBlock(header) : []
  const fromUsage = usage.length > 0 ? usageParams(usage, scriptBaseName(script)) ?? [] : []
  // A Usage line with an operand before an option says the script reads that
  // operand itself first; getopts would stop at it. Not an options-first form.
  const firstOperand = fromUsage.findIndex((param) => param.kind === 'positional')
  if (firstOperand !== -1 && fromUsage.slice(firstOperand).some((param) => param.kind !== 'positional')) surprise()
  const letters = new Map(getopts.map((getopt) => [getopt.letter, getopt]))
  const variables = new Map<string, number>()
  for (const getopt of getopts) {
    const name = getopt.variable?.toLowerCase()
    if (name) variables.set(name, (variables.get(name) ?? 0) + 1)
  }
  const reserved = new Set(fromUsage
    .filter((param) => param.kind === 'positional' || param.flags.some((flag) => flag.startsWith('--')))
    .map((param) => param.id))
  /** A letter's id and label: its arm's variable when only it sets that, else its flag. */
  const naming = (getopt: Getopt): { id: string; label: string } => {
    const name = getopt.variable?.toLowerCase() ?? null
    if (name && variables.get(name) === 1 && !reserved.has(name)) return { id: name, label: humanise(name) }
    return { id: `opt_${getopt.letter}`, label: `-${getopt.letter}` }
  }
  const taken = new Set<string>()
  const params: ScriptParam[] = []
  for (const param of fromUsage) {
    if (param.kind === 'positional') { params.push(param); continue }
    const shorts = param.flags.filter((flag) => /^-[A-Za-z0-9]$/.test(flag))
    if (shorts.length === 0) surprise()
    const known = shorts.map((flag) => letters.get(flag[1]) ?? surprise())
    for (const getopt of known) {
      if (taken.has(getopt.letter) || getopt.value !== (param.kind === 'value')) surprise()
      taken.add(getopt.letter)
    }
    if (param.kind === 'switch' && known.every((getopt) => getopt.exits)) continue
    const long = param.flags.some((flag) => flag.startsWith('--'))
    param.flags = shorts
    if (!long) Object.assign(param, naming(known[0]))
    if (param.kind === 'value') param.valueType = refineType(param.valueType, param.id, param.metavar, param.help)
    params.push(param)
  }
  for (const getopt of getopts) {
    if (taken.has(getopt.letter) || (getopt.exits && !getopt.value)) continue
    const { id, label } = naming(getopt)
    params.push(makeParam({
      id, label, kind: getopt.value ? 'value' : 'switch', flags: [`-${getopt.letter}`],
      valueType: getopt.value ? refineType('text', id, null, null) : 'text'
    }))
  }
  return { params, usage }
}

function shellSpec(source: string, script: string): ScriptSpec | null {
  const header = shellHeader(source)
  try {
    const getopts = /\bgetopts\b/.test(source) ? getoptsLetters(lexShell(source)) : null
    let params: ScriptParam[]
    let usageLines: string[]
    if (getopts) {
      ;({ params, usage: usageLines } = getoptsParams(getopts, header, script))
    } else {
      if (!header) return null
      usageLines = usageBlock(header)
      if (usageLines.length === 0) return null
      params = usageParams(usageLines, scriptBaseName(script)) ?? []
    }
    if (header) applyOptionLines(header, params)
    const finished = finish(params)
    if (!finished) return null
    // The header's first line is the summary unless it is the Usage line itself.
    const doc = header === null || /^\s*usage\s*:/i.test(header.split('\n')[0]) ? null : header
    return {
      script, language: 'shell', ...summaryAndDescription(doc), usage: usageLines.length > 0 ? usageLines.join('\n') : null,
      params: finished, ...(getopts ? { optionsFirst: true } : {})
    }
  } catch (error) {
    if (error instanceof Surprise) return null
    throw error
  }
}
