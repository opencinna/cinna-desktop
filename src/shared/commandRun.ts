/**
 * Commands in an agent's reply that the user may run from the message menu.
 *
 * Pure, with no filesystem: the renderer decides the menu's items from it
 * synchronously when the menu opens, and main reuses the same parser for the
 * authoritative rule (`services/localAgents/ownCommandPolicy.ts`), which is
 * also the rule Antigravity's auto-approval uses. `looksAutoRunnable` is the
 * disk-free half of that rule; main checks the rest against the agent's real
 * folder at run time and answers `needs_review` when it fails.
 */

/**
 * A POSIX-ish word splitter for one simple command: whitespace, single
 * quotes, double quotes and backslash escapes. Null for anything a shell
 * would treat as more than literal words — operators, redirections,
 * substitutions, globs, tilde, comments, zsh's `=cmd` and `^` — or that does
 * not parse.
 */
export function splitCommandLine(line: string): string[] | null {
  if (/[\0-\x08\x0a-\x1f\x7f`]/.test(line)) return null
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      continue
    }
    if (ch === '$') return null
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < line.length && '\\"'.includes(line[i + 1])) word += line[++i]
      else word += ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) { words.push(word); word = ''; inWord = false }
      continue
    }
    if (';&|<>()*?[{~^'.includes(ch)) return null
    // `#` starts a comment, and `=` expands a command path in zsh, at the start of a word.
    if (!inWord && (ch === '#' || ch === '=')) return null
    inWord = true
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '\\') {
      if (i + 1 >= line.length) return null
      word += line[++i]
      continue
    }
    word += ch
  }
  if (quote !== null) return null
  if (inWord) words.push(word)
  return words
}

export const INTERPRETERS: ReadonlySet<string> = new Set(['python', 'python3', 'node', 'bash', 'sh'])
export const UV_RUN_FLAGS: ReadonlySet<string> = new Set(['--quiet', '-q', '--no-project'])
/** The read-only basics the own-command rule knows; their option tables live with the fs-aware rule. */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'file', 'stat', 'find'])

/** A leading `NAME=value` word: an environment assignment, which the rule never runs. */
export const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The script word of `[interpreter] script args…`, or null when the line is not that form. */
export function scriptWord(words: string[]): string | null {
  const [first] = words
  if (first === undefined) return null
  if (INTERPRETERS.has(first)) {
    const script = words[1]
    return script !== undefined && !script.startsWith('-') && script !== '' ? script : null
  }
  if (first === 'uv') {
    if (words[1] !== 'run') return null
    let i = 2
    while (i < words.length && UV_RUN_FLAGS.has(words[i])) i++
    const next = words[i]
    if (next === 'python' || next === 'python3') {
      const script = words[i + 1]
      return script !== undefined && !script.startsWith('-') && script !== '' ? script : null
    }
    return next !== undefined && !next.startsWith('-') && next.endsWith('.py') ? next : null
  }
  return first.includes('/') ? first : null
}

/* ------------------------------------------------- read-only option tables */

/**
 * The options a read-only command may take, by arity and by **exact** name:
 * an option outside its table is refused, so a GNU long-option abbreviation
 * (`--files=` for `--files-from`) or a misread value that could hide a path
 * never passes. Shared by the menu's disk-free check and main's rule, so the
 * two refuse the same options.
 */
export interface OptionTable {
  /** Short letters that take no value. */
  shortFlags: string
  /** Short letters that take a value (the rest of the word, or the next word). */
  shortValues: string
  longFlags: ReadonlySet<string>
  longValues: ReadonlySet<string>
}

const table = (shortFlags: string, shortValues = '', longFlags: string[] = [], longValues: string[] = []): OptionTable =>
  ({ shortFlags, shortValues, longFlags: new Set(longFlags), longValues: new Set(longValues) })

export const GREP_OPTIONS = table('iyvwxcLloqsbHhnTZzaIrEFGPUu', 'ABCemdD',
  ['ignore-case', 'no-ignore-case', 'invert-match', 'word-regexp', 'line-regexp', 'count',
    'files-with-matches', 'files-without-match', 'only-matching', 'quiet', 'silent', 'no-messages', 'byte-offset',
    'with-filename', 'no-filename', 'line-number', 'initial-tab', 'null', 'null-data', 'text', 'recursive',
    'extended-regexp', 'fixed-strings', 'basic-regexp', 'perl-regexp', 'color', 'colour', 'line-buffered'],
  ['regexp', 'max-count', 'after-context', 'before-context', 'context', 'include', 'exclude',
    'exclude-dir', 'directories', 'devices', 'label', 'binary-files', 'color', 'colour'])

export const RG_OPTIONS = table('isSvwxclnNHIoquUaFP0b', 'ABCegmtTMjEd',
  ['ignore-case', 'case-sensitive', 'smart-case', 'invert-match', 'word-regexp', 'line-regexp',
    'count', 'count-matches', 'files-with-matches', 'files-without-match', 'line-number', 'no-line-number',
    'with-filename', 'no-filename', 'only-matching', 'quiet', 'hidden', 'no-ignore', 'no-ignore-vcs',
    'fixed-strings', 'pcre2', 'text', 'null', 'vimgrep', 'json', 'no-heading', 'heading', 'column', 'files',
    'stats', 'trim', 'multiline', 'unrestricted', 'no-messages', 'byte-offset', 'sort-files', 'crlf', 'passthru',
    'one-file-system', 'no-config'],
  ['regexp', 'glob', 'iglob', 'type', 'type-not', 'max-count', 'max-depth', 'after-context',
    'before-context', 'context', 'max-filesize', 'max-columns', 'sort', 'sortr', 'encoding', 'threads', 'color',
    'colors', 'engine', 'context-separator', 'field-match-separator', 'path-separator'])

/**
 * The plain readers. None follows (`tail -f`), reads a list of names or a
 * magic file from another path (`file -f/-m`, `wc --files0-from`) or writes
 * (`file -C`): only what is listed here passes. `-5` (head/tail's old count
 * form) is digits as flags.
 */
export const PLAIN_OPTIONS: Readonly<Record<string, OptionTable>> = {
  ls: table('1aAlhRtrSFdiG'),
  pwd: table('LP'),
  cat: table('nbsvetA'),
  head: table('qv0123456789', 'nc'),
  tail: table('qv0123456789', 'nc'),
  wc: table('lwcmL'),
  file: table('biI', '', ['brief', 'mime-type']),
  stat: table('xstLl')
}

/** Readers that read standard input when given no path, and would wait on it. */
export const NEEDS_PATH: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'wc', 'file', 'stat'])

// No `-L` and no `-follow`: following links would list names outside the folder.
export const FIND_GLOBAL: ReadonlySet<string> = new Set(['-H', '-P', '-E', '-s', '-x', '-X', '-d'])
export const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from', '-follow'])

export interface ParsedOptions {
  positionals: string[]
  /** Every short letter given, in order (values excluded). */
  letters: string
  /** Every long option name given. */
  longs: string[]
}

/** Parse words by an {@link OptionTable}; `{ bad }` names the first word it does not know, exactly. */
export function parseOptions(options: OptionTable, words: string[]): ParsedOptions | { bad: string } {
  const parsed: ParsedOptions = { positionals: [], letters: '', longs: [] }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === '--') { parsed.positionals.push(...words.slice(i + 1)); break }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = word.slice(2, eq === -1 ? undefined : eq)
      if (eq !== -1) {
        if (!options.longValues.has(name)) return { bad: word.slice(0, eq) }
      } else if (options.longFlags.has(name)) {
        // a flag
      } else if (options.longValues.has(name)) {
        if (i + 1 >= words.length) return { bad: word }
        i++
      } else {
        return { bad: word }
      }
      parsed.longs.push(name)
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      for (let j = 1; j < word.length; j++) {
        const letter = word[j]
        if (options.shortFlags.includes(letter)) { parsed.letters += letter; continue }
        if (!options.shortValues.includes(letter)) return { bad: `-${letter}` }
        parsed.letters += letter
        if (j === word.length - 1) {
          if (i + 1 >= words.length) return { bad: `-${letter}` }
          i++
        }
        break
      }
      continue
    }
    if (word === '-') return { bad: word }
    parsed.positionals.push(word)
  }
  return parsed
}

/** What a `grep` / `rg` reads: its paths, whether it recurses, and whether it reads hidden entries. */
export interface SearchShape {
  paths: string[]
  recursive: boolean
  hidden: boolean
}

export function searchShape(command: 'grep' | 'rg', parsed: ParsedOptions): SearchShape {
  // `rg --files` takes no pattern: every positional is a root. `-e` anywhere
  // in a short group is read as a pattern option, so nothing is skipped.
  const patternByOption = parsed.letters.includes('e') || parsed.longs.includes('regexp') ||
    (command === 'rg' && parsed.longs.includes('files'))
  const paths = patternByOption ? parsed.positionals : parsed.positionals.slice(1)
  const recursive = command === 'rg' || /[rd]/.test(parsed.letters) ||
    parsed.longs.includes('recursive') || parsed.longs.includes('directories')
  // grep reads dotfiles; rg only with --hidden or a second -u.
  const hidden = command === 'grep' || parsed.longs.includes('hidden') ||
    (parsed.letters.match(/u/g)?.length ?? 0) + parsed.longs.filter((name) => name === 'unrestricted').length >= 2
  return { paths, recursive, hidden }
}

/** The start paths and the actions of a `find`, or `{ bad }` for an option outside its tables. */
export function findShape(args: string[]): { starts: string[] } | { bad: string } {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    if (!FIND_GLOBAL.has(args[i])) return { bad: args[i] }
    i++
  }
  const starts: string[] = []
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '(' && args[i] !== '!') starts.push(args[i++])
  const action = args.slice(i).find((word) => FIND_ACTIONS.has(word))
  if (action !== undefined) return { bad: action }
  return { starts: starts.length > 0 ? starts : ['.'] }
}

/** A path word that names the working folder itself, judged without the disk (`.`, `./`, `''`). */
export function namesCwd(path: string): boolean {
  return path.split(/[/\\]/).every((segment) => segment === '' || segment === '.')
}

/**
 * The disk-free half of the read-only basics: false where main would refuse
 * whatever the disk holds — an option outside the tables, a reader with no
 * path, a search with no root or rooted at the folder itself.
 */
function readOnlyLooksAllowed(command: string, args: string[]): boolean {
  if (command === 'grep' || command === 'rg') {
    const parsed = parseOptions(command === 'rg' ? RG_OPTIONS : GREP_OPTIONS, args)
    if ('bad' in parsed) return false
    const { paths, recursive } = searchShape(command, parsed)
    if (!recursive) return paths.length > 0
    return paths.length > 0 && !paths.some(namesCwd)
  }
  if (command === 'find') return !('bad' in findShape(args))
  const options = PLAIN_OPTIONS[command]
  if (!options) return false
  const parsed = parseOptions(options, args)
  if ('bad' in parsed) return false
  return !(NEEDS_PATH.has(command) && parsed.positionals.length === 0)
}

/**
 * Whether the command could pass the own-command rule, judged without the
 * disk: one simple command that is the agent's own script on a relative path
 * with no `..`, or one of the read-only basics with options from their tables
 * (and, for a recursive search, a root that is not the folder itself). The
 * menu offers Run and Run in background only for these; main decides for real
 * at run time.
 */
export function looksAutoRunnable(command: string): boolean {
  const words = splitCommandLine(command.trim())
  if (!words || words.length === 0) return false
  const [first] = words
  if (ENV_ASSIGNMENT.test(first)) return false
  if (READ_ONLY_COMMANDS.has(first)) return readOnlyLooksAllowed(first, words.slice(1))
  const script = scriptWord(words)
  if (script === null) return false
  if (script.startsWith('/') || script.startsWith('\\')) return false
  return !script.split(/[/\\]/).includes('..')
}

/**
 * Command names an inline code span may start with to count as a command
 * (with at least one more word). Recognising is not running: anything outside
 * {@link looksAutoRunnable} is offered as Edit and Run… only.
 */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  'uv', 'uvx', 'python', 'python3', 'pip', 'pip3', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'make',
  'git', 'gh', 'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'jq', 'tree', 'du', 'df', 'curl', 'wget',
  'docker', 'cargo', 'go', 'pytest', 'ruff', 'bash', 'sh', 'zsh', 'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch',
  'chmod', 'chown', 'kill', 'sed', 'awk', 'open', 'echo', 'printf', 'env', 'export', 'which', 'file', 'stat', 'pwd',
  'cd', 'tar', 'unzip', 'zip', 'ssh', 'scp', 'rsync', 'brew', 'sudo', 'diff', 'sort', 'uniq', 'xargs', 'ps', 'lsof',
  'ping', 'kubectl', 'terraform', 'swift', 'xcodebuild', 'java', 'mvn', 'gradle', 'ruby', 'gem', 'bundle', 'php',
  'composer', 'poetry', 'pipx', 'conda', 'tsc', 'vitest', 'jest', 'eslint', 'prettier', 'black', 'mypy', 'cinna'
])

const SHELL_LANGS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'shell', 'console'])

/** Strip one leading prompt: `$ `, `% `, or `!` (with or without a space after it). */
function stripPrompt(line: string): string {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('$ ') || trimmed.startsWith('% ')) return trimmed.slice(2).trim()
  if (trimmed.startsWith('!')) return trimmed.slice(1).trim()
  return trimmed.trim()
}

/** The inline rule, on a prompt-stripped line: a known command with an argument, or `./something`. */
function inlineCommand(line: string): boolean {
  if (line.startsWith('./') && line.length > 2) return true
  const words = line.split(/\s+/).filter((word) => word !== '')
  return words.length >= 2 && KNOWN_COMMANDS.has(words[0])
}

const commentOrBlank = (line: string): boolean => line === '' || line.startsWith('#')

export interface DetectCommandOptions {
  /** A fenced code block, rather than an inline code span. */
  fenced: boolean
  /** The block's language, lowercased or not; null or empty when it has none. */
  lang?: string | null
}

/**
 * The command a code span or block in a reply holds, or null when it does
 * not look like one. Prompts (`$ `, `% `, a leading `!`) are stripped, so the
 * result is exactly what runs, what the edit dialog shows and what the rule
 * checks. A shell block keeps its non-comment lines; a `console` block only
 * its prompt lines; a block with no language counts only when every line
 * passes the inline rule.
 */
export function detectCommand(text: string, options: DetectCommandOptions): string | null {
  if (!options.fenced) {
    const line = stripPrompt(text.trim())
    if (line === '' || /[\r\n]/.test(line)) return null
    return inlineCommand(line) ? line : null
  }
  const lang = (options.lang ?? '').trim().toLowerCase()
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  let lines: string[]
  if (lang === 'console') {
    lines = raw.map((line) => line.trimStart())
      .filter((line) => line.startsWith('$ ') || line.startsWith('% '))
      .map((line) => line.slice(2).trim())
      .filter((line) => !commentOrBlank(line))
  } else if (SHELL_LANGS.has(lang)) {
    lines = raw.map(stripPrompt).filter((line) => !commentOrBlank(line))
  } else if (lang === '') {
    const kept = raw.map(stripPrompt).filter((line) => line !== '')
    if (kept.length === 0 || !kept.every(inlineCommand)) return null
    lines = kept
  } else {
    return null
  }
  if (lines.length === 0) return null
  return lines.join('\n')
}

/** The word an output attachment is named after: `output-<first word>.txt`. */
export function commandFirstWord(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return safeNameWord(first.split('/').pop() ?? '')
}

/** The part of a word a file name may carry; empty when none of it may. */
function nameSafe(word: string): string {
  return word.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 40)
}

function safeNameWord(word: string): string {
  return nameSafe(word) || 'command'
}

/**
 * The name of a run's output attachment: `output-<script>.txt` (the script's
 * base name, its extension dropped) for an own-script form
 * (`uv run scripts/check.py` → `output-check.txt`), else
 * `output-<first word>.txt`.
 */
export function commandOutputFilename(command: string): string {
  const words = splitCommandLine(command.trim())
  const script = words ? scriptWord(words) : null
  if (script !== null) {
    const base = script.split(/[/\\]/).pop() ?? ''
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const safe = nameSafe(stem)
    if (safe !== '') return `output-${safe}.txt`
  }
  return `output-${commandFirstWord(command)}.txt`
}
