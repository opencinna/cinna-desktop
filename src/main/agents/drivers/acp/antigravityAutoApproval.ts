/**
 * Which of an Antigravity folder agent's permission asks Cinna answers itself.
 *
 * Antigravity on **Ask for approval** (server mode `default`) raises a
 * `session/request_permission` for every command and every edit, and the
 * server has no allowlist of its own (1.3.0: `_meta.agy` takes only
 * `enabledTools` / `disabledTools`; `auto_edit` approves an edit to any path).
 * Cinna's standing grants are exact `{command,cwd}` strings, so a skill script
 * run with new arguments would ask every time. This module is the narrow rule
 * that settles some of those asks silently, like a standing grant:
 *
 * - **An edit** whose every location is inside the agent's folder and not
 *   protected.
 * - **A command** run in the folder that is one simple command — the agent's
 *   own script (optionally under an interpreter), or one of a few read-only
 *   basics on paths inside the folder.
 *
 * Pure apart from the filesystem, which is injectable for tests. **Fails
 * closed**: anything it cannot parse, does not know, or cannot read answers
 * false, and the ask falls through to the grants and then to the user.
 *
 * Containment is decided on real paths: the folder is realpathed, an existing
 * path is realpathed, and a path that does not exist yet is its nearest
 * existing ancestor's real path plus the rest — so a symlink that points out
 * of the folder is outside it, and a dangling one is refused.
 */

import { lstatSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The plan's policy: the agent's folder, and the folders of its pinned (catalog, marketplace) skills. */
export interface AntigravityAutoApprovalPolicy {
  folder: string
  scriptRoots: readonly string[]
}

/** The part of the ask the rule reads. */
export interface AntigravityAskedCall {
  kind?: string | null
  rawInput?: unknown
  locations?: readonly { path: string }[] | null
}

interface EntryInfo {
  isFile(): boolean
  isDirectory(): boolean
}

interface DirEntryInfo {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** The filesystem the rule reads, injectable for tests. Each call may throw; `lstat`/`stat` return null for "absent". */
export interface AutoApprovalFs {
  realpath(path: string): string
  lstat(path: string): EntryInfo | null
  stat(path: string): EntryInfo | null
  /** A directory's entries, not following symlinks. */
  readdir(path: string): DirEntryInfo[]
}

const absent = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export const nodeAutoApprovalFs: AutoApprovalFs = {
  realpath: (path) => realpathSync.native(path),
  lstat: (path) => {
    try { return lstatSync(path) } catch (error) { if (absent(error)) return null; throw error }
  },
  stat: (path) => {
    try { return statSync(path) } catch (error) { if (absent(error)) return null; throw error }
  },
  readdir: (path) => {
    const entries: Dirent[] = readdirSync(path, { withFileTypes: true })
    return entries
  }
}

/**
 * Whether Cinna answers this ask `allow` without asking. Only `edit` and
 * `execute` are ever allowed; every other kind is left alone.
 */
export function antigravityAutoApproves(
  policy: AntigravityAutoApprovalPolicy,
  call: AntigravityAskedCall,
  fs: AutoApprovalFs = nodeAutoApprovalFs
): boolean {
  try {
    if (typeof policy.folder !== 'string' || !isAbsolute(policy.folder)) return false
    const folder = fs.realpath(resolve(policy.folder))
    if (call.kind === 'edit') return editAllowed(folder, call.locations, fs)
    if (call.kind === 'execute') return commandAllowed(folder, policy.scriptRoots, call.rawInput, fs)
    return false
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------- paths */

/**
 * The real path of `path` (absolute, lexically normalised first), or null.
 * A path that does not exist resolves through its nearest existing ancestor;
 * an entry that exists but cannot be resolved (a dangling symlink) is null.
 */
export function realPathOf(path: string, fs: AutoApprovalFs): string | null {
  let current = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      const real = fs.realpath(current)
      return rest.length > 0 ? join(real, ...rest.reverse()) : real
    } catch (error) {
      if (!absent(error)) return null
    }
    // Absent to realpath but present to lstat: a link to nowhere. Writing
    // through it would create its target, wherever that is.
    if (fs.lstat(current) !== null) return null
    const parent = dirname(current)
    if (parent === current) return null
    rest.push(basename(current))
    current = parent
  }
}

function within(path: string, root: string): boolean {
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** The path's segments relative to the folder, lowercased (APFS and NTFS fold case). Null when outside. */
function segmentsIn(folder: string, real: string): string[] | null {
  if (!within(real, folder)) return null
  const rel = relative(folder, real)
  return rel === '' ? [] : rel.split(sep).map((segment) => segment.toLowerCase())
}

/** A file name that carries secrets, wherever it is (OpenCode's denies: `*.env`, `*.pem`, `*.key`, `*credentials.json`). */
function secretName(segment: string): boolean {
  return segment === '.env' || segment.endsWith('.env') || segment.startsWith('.env.') ||
    segment.endsWith('.pem') || segment.endsWith('.key') || segment.endsWith('credentials.json')
}

/**
 * Whether a path inside the folder is one Cinna always asks about:
 * the isolated Antigravity home (`.cinna/`, whose `config/hooks.json` runs on
 * every tool call), workspace hooks (`.agents/`), any `.git/`, the grant
 * store (`app-data/desktop*`), `credentials/` and secret-looking files.
 * For a read, `credentials/README.md` is the one exception; for a write,
 * every hidden (dot-prefixed) path is protected too.
 */
const INSTRUCTION_FILES = new Set(['agents.md', 'gemini.md', 'claude.md'])

function isProtected(segments: string[], mode: 'read' | 'write'): boolean {
  if (segments.length === 0) return false
  // Hidden files are where tools keep configuration that runs or steers code
  // (`.claude/settings.json`, `.envrc`, `.agent/rules/`): never edited unasked.
  if (mode === 'write' && segments.some((segment) => segment.startsWith('.'))) return true
  // Instruction files the engines read every session: an edit there outlives the turn.
  if (mode === 'write' && INSTRUCTION_FILES.has(segments[segments.length - 1])) return true
  const [first, second] = segments
  if (first === '.cinna' || first === '.agents') return true
  if (segments.includes('.git')) return true
  if (first === 'app-data' && second !== undefined && second.startsWith('desktop')) return true
  if (first === 'credentials') {
    return !(mode === 'read' && segments.length === 2 && second === 'readme.md')
  }
  return segments.some(secretName)
}

/** The real path of `path` when it is inside the folder and not protected, else null. */
function allowedPath(folder: string, path: string, mode: 'read' | 'write', fs: AutoApprovalFs): string | null {
  const real = realPathOf(path, fs)
  if (real === null) return null
  const segments = segmentsIn(folder, real)
  if (segments === null || isProtected(segments, mode)) return null
  return real
}

/* -------------------------------------------------------------------- edits */

function editAllowed(folder: string, locations: AntigravityAskedCall['locations'], fs: AutoApprovalFs): boolean {
  if (!Array.isArray(locations) || locations.length === 0) return false
  return locations.every((location) =>
    typeof location?.path === 'string' && isAbsolute(location.path) && allowedPath(folder, location.path, 'write', fs) !== null)
}

/* ----------------------------------------------------------------- commands */

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

const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh'])
const UV_RUN_FLAGS = new Set(['--quiet', '-q', '--no-project'])
const READ_ONLY = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'file', 'stat', 'find'])

function rawString(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  return null
}

function commandAllowed(folder: string, scriptRoots: readonly string[], rawInput: unknown, fs: AutoApprovalFs): boolean {
  if (!rawInput || typeof rawInput !== 'object') return false
  const input = rawInput as Record<string, unknown>
  const line = rawString(input, 'CommandLine', 'command_line')
  const cwdRaw = rawString(input, 'Cwd', 'working_dir')
  if (line === null || cwdRaw === null || !isAbsolute(cwdRaw)) return false
  const cwd = fs.realpath(resolve(cwdRaw))
  const cwdSegments = segmentsIn(folder, cwd)
  // A cwd in a protected folder (`credentials/`, `.cinna/`) would let `ls` list it.
  if (cwdSegments === null || isProtected(cwdSegments, 'read')) return false
  const words = splitCommandLine(line)
  if (!words || words.length === 0) return false
  const [command] = words
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) return false
  if (READ_ONLY.has(command)) return readOnlyAllowed(folder, cwd, command, words.slice(1), fs)
  return scriptAllowed(folder, cwd, scriptRoots, words, fs)
}

/* ---------------------------------------------------------- the own script */

/** The script word of `[interpreter] script args…`, or null when the line is not that form. */
function scriptWord(words: string[]): string | null {
  const [first] = words
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

function scriptAllowed(folder: string, cwd: string, scriptRoots: readonly string[], words: string[], fs: AutoApprovalFs): boolean {
  const word = scriptWord(words)
  if (word === null) return false
  const real = realPathOf(resolve(cwd, word), fs)
  if (real === null || !fs.stat(real)?.isFile()) return false
  const inFolder = segmentsIn(folder, real)
  if (inFolder !== null) return !isProtected(inFolder, 'write')
  for (const root of scriptRoots) {
    if (typeof root !== 'string' || !isAbsolute(root)) continue
    let realRoot: string
    try { realRoot = fs.realpath(resolve(root)) } catch { continue }
    const segments = segmentsIn(realRoot, real)
    if (segments !== null && segments.length > 0 && !segments.some((s) => s === '.git' || secretName(s))) return true
  }
  return false
}

/* ------------------------------------------------------- read-only basics */

/**
 * The options a read-only command may take, by arity and by **exact** name:
 * an option outside its table is refused, so a GNU long-option abbreviation
 * (`--files=` for `--files-from`) or a misread value that could hide a path
 * never passes.
 */
interface OptionTable {
  /** Short letters that take no value. */
  shortFlags: string
  /** Short letters that take a value (the rest of the word, or the next word). */
  shortValues: string
  longFlags: ReadonlySet<string>
  longValues: ReadonlySet<string>
}

const table = (shortFlags: string, shortValues = '', longFlags: string[] = [], longValues: string[] = []): OptionTable =>
  ({ shortFlags, shortValues, longFlags: new Set(longFlags), longValues: new Set(longValues) })

const GREP = table('iyvwxcLloqsbHhnTZzaIrEFGPUu', 'ABCemdD',
  ['ignore-case', 'no-ignore-case', 'invert-match', 'word-regexp', 'line-regexp', 'count',
    'files-with-matches', 'files-without-match', 'only-matching', 'quiet', 'silent', 'no-messages', 'byte-offset',
    'with-filename', 'no-filename', 'line-number', 'initial-tab', 'null', 'null-data', 'text', 'recursive',
    'extended-regexp', 'fixed-strings', 'basic-regexp', 'perl-regexp', 'color', 'colour', 'line-buffered'],
  ['regexp', 'max-count', 'after-context', 'before-context', 'context', 'include', 'exclude',
    'exclude-dir', 'directories', 'devices', 'label', 'binary-files', 'color', 'colour'])

const RG = table('isSvwxclnNHIoquUaFP0b', 'ABCegmtTMjEd',
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
const PLAIN: Readonly<Record<string, OptionTable>> = {
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
const NEEDS_PATH = new Set(['cat', 'head', 'tail', 'wc', 'file', 'stat'])

interface ParsedOptions {
  positionals: string[]
  /** Every short letter given, in order (values excluded). */
  letters: string
  /** Every long option name given. */
  longs: string[]
}

/** Parse words by an {@link OptionTable}; null on an option it does not know, exactly. */
function parseOptions(options: OptionTable, words: string[]): ParsedOptions | null {
  const parsed: ParsedOptions = { positionals: [], letters: '', longs: [] }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === '--') { parsed.positionals.push(...words.slice(i + 1)); break }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = word.slice(2, eq === -1 ? undefined : eq)
      if (eq !== -1) {
        if (!options.longValues.has(name)) return null
      } else if (options.longFlags.has(name)) {
        // a flag
      } else if (options.longValues.has(name)) {
        if (i + 1 >= words.length) return null
        i++
      } else {
        return null
      }
      parsed.longs.push(name)
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      for (let j = 1; j < word.length; j++) {
        const letter = word[j]
        if (options.shortFlags.includes(letter)) { parsed.letters += letter; continue }
        if (!options.shortValues.includes(letter)) return null
        parsed.letters += letter
        if (j === word.length - 1) {
          if (i + 1 >= words.length) return null
          i++
        }
        break
      }
      continue
    }
    if (word === '-') return null
    parsed.positionals.push(word)
  }
  return parsed
}

/** How many entries a recursive search's tree may hold before Cinna stops looking and asks. */
const MAX_WALK = 5000

/**
 * Whether every entry under a search root is one Cinna would let the agent
 * read: nothing protected, and — where the search reads them — no hidden
 * entry. Symlinked directories are not followed (neither grep -r nor rg does);
 * a tree over {@link MAX_WALK} entries, or one that cannot be read, asks.
 */
function treeReadable(folder: string, root: string, hidden: boolean, fs: AutoApprovalFs): boolean {
  if (!fs.lstat(root)?.isDirectory()) return true
  const queue = [root]
  let seen = 0
  while (queue.length > 0) {
    const dir = queue.shift()!
    for (const entry of fs.readdir(dir)) {
      if (++seen > MAX_WALK) return false
      const path = join(dir, entry.name)
      const segments = segmentsIn(folder, path)
      if (segments === null || isProtected(segments, 'read')) return false
      if (hidden && entry.name.startsWith('.')) return false
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(path)
    }
  }
  return true
}

/**
 * A recursive search may start anywhere inside the folder except the folder
 * itself or an ancestor of `credentials/` or the isolated home, and only over
 * a tree in which it would read nothing protected.
 */
function searchRootAllowed(folder: string, cwd: string, root: string, hidden: boolean, fs: AutoApprovalFs): boolean {
  const real = allowedPath(folder, resolve(cwd, root), 'read', fs)
  if (real === null || real === folder) return false
  if (within(join(folder, 'credentials'), real) || within(join(folder, '.cinna'), real)) return false
  return treeReadable(folder, real, hidden, fs)
}

function searchAllowed(folder: string, cwd: string, command: 'grep' | 'rg', args: string[], fs: AutoApprovalFs): boolean {
  const parsed = parseOptions(command === 'rg' ? RG : GREP, args)
  if (!parsed) return false
  // `rg --files` takes no pattern: every positional is a root. `-e` anywhere
  // in a short group is read as a pattern option, so nothing is skipped.
  const patternByOption = parsed.letters.includes('e') || parsed.longs.includes('regexp') ||
    (command === 'rg' && parsed.longs.includes('files'))
  const paths = patternByOption ? parsed.positionals : parsed.positionals.slice(1)
  const recursive = command === 'rg' || /[rd]/.test(parsed.letters) ||
    parsed.longs.includes('recursive') || parsed.longs.includes('directories')
  if (!recursive) return paths.length > 0 && paths.every((path) => allowedPath(folder, resolve(cwd, path), 'read', fs) !== null)
  // grep reads dotfiles; rg only with --hidden or a second -u.
  const hidden = command === 'grep' || parsed.longs.includes('hidden') ||
    (parsed.letters.match(/u/g)?.length ?? 0) + parsed.longs.filter((name) => name === 'unrestricted').length >= 2
  const roots = paths.length > 0 ? paths : ['.']
  return roots.every((root) => searchRootAllowed(folder, cwd, root, hidden, fs))
}

function readOnlyAllowed(folder: string, cwd: string, command: string, args: string[], fs: AutoApprovalFs): boolean {
  if (command === 'grep' || command === 'rg') return searchAllowed(folder, cwd, command, args, fs)
  if (command === 'find') return findAllowed(folder, cwd, args, fs)
  const options = PLAIN[command]
  if (!options) return false
  const parsed = parseOptions(options, args)
  if (!parsed) return false
  if (NEEDS_PATH.has(command) && parsed.positionals.length === 0) return false
  return parsed.positionals.every((word) => allowedPath(folder, resolve(cwd, word), 'read', fs) !== null)
}

// No `-L` and no `-follow`: following links would list names outside the folder.
const FIND_GLOBAL = new Set(['-H', '-P', '-E', '-s', '-x', '-X', '-d'])
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from', '-follow'])

/**
 * `find` lists names, not contents, so it may start at the folder itself;
 * every start path must still be inside the folder and readable, and the
 * actions that run, delete or write are refused.
 */
function findAllowed(folder: string, cwd: string, args: string[], fs: AutoApprovalFs): boolean {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    if (!FIND_GLOBAL.has(args[i])) return false
    i++
  }
  const starts: string[] = []
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '(' && args[i] !== '!') starts.push(args[i++])
  if (args.slice(i).some((word) => FIND_ACTIONS.has(word))) return false
  return (starts.length > 0 ? starts : ['.']).every((start) => allowedPath(folder, resolve(cwd, start), 'read', fs) !== null)
}
