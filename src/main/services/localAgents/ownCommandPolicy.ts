/**
 * The own-command rule: which commands an agent may run in its folder without
 * asking. One simple command that is the agent's **own script** (optionally
 * under an interpreter), or one of a few **read-only basics** on paths inside
 * the folder.
 *
 * Two features read it, so they cannot drift apart: Antigravity's
 * auto-approval settles a folder agent's `execute` asks by it
 * (`agents/drivers/acp/antigravityAutoApproval.ts`, which keeps its own edit
 * rule and reads the ask's rawInput), and a message's Run / Run in background
 * is checked against it before it runs (`services/userCommands`). Making it
 * stricter or looser changes both, on purpose.
 *
 * The parser is pure and shared with the renderer (`shared/commandRun.ts`);
 * this module adds the filesystem, which is injectable for tests. **Fails
 * closed**: anything it cannot parse, does not know, or cannot read answers
 * false.
 *
 * Containment is decided on real paths: the folder is realpathed, an existing
 * path is realpathed, and a path that does not exist yet is its nearest
 * existing ancestor's real path plus the rest — so a symlink that points out
 * of the folder is outside it, and a dangling one is refused.
 */

import { lstatSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  ENV_ASSIGNMENT,
  GREP_OPTIONS,
  NEEDS_PATH,
  PLAIN_OPTIONS,
  READ_ONLY_COMMANDS,
  RG_OPTIONS,
  findShape,
  parseOptions,
  scriptWord,
  searchShape,
  splitCommandLine
} from '../../../shared/commandRun'

/** The agent's folder, and the folders of its pinned (catalog, marketplace) skills, whose scripts count as its own. */
export interface OwnCommandPolicy {
  folder: string
  scriptRoots: readonly string[]
}

export interface EntryInfo {
  isFile(): boolean
  isDirectory(): boolean
  /** Device and inode, where the filesystem gives them: what {@link readableOwnScript} pins the file it judged by. */
  dev?: number
  ino?: number
}

/** The script {@link readableOwnScript} judged: its real path, and the device and inode `stat` found there. */
export interface ReadableOwnScript {
  real: string
  dev: number
  ino: number
}

export interface DirEntryInfo {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** The filesystem the rule reads, injectable for tests. Each call may throw; `lstat`/`stat` return null for "absent". */
export interface OwnCommandFs {
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

export const nodeOwnCommandFs: OwnCommandFs = {
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

/* -------------------------------------------------------------------- paths */

/**
 * The real path of `path` (absolute, lexically normalised first), or null.
 * A path that does not exist resolves through its nearest existing ancestor;
 * an entry that exists but cannot be resolved (a dangling symlink) is null.
 */
export function realPathOf(path: string, fs: OwnCommandFs): string | null {
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
export function allowedPath(folder: string, path: string, mode: 'read' | 'write', fs: OwnCommandFs): string | null {
  const real = realPathOf(path, fs)
  if (real === null) return null
  const segments = segmentsIn(folder, real)
  if (segments === null || isProtected(segments, mode)) return null
  return real
}

/* ------------------------------------------------------------------ reasons */

/**
 * Why a command is not one the agent may run unasked, as the sentence the
 * edit dialog shows. Each names what it can (the script, the option).
 */
export const OWN_COMMAND_REASONS = {
  empty: 'Type a command to run.',
  unreadable: 'The agent’s folder could not be read, so this command runs after you check it.',
  cwd: 'The command would run outside the agent’s folder.',
  notSimple: 'This is more than one simple command (a pipe, &&, a redirect or $), so it runs after you check it.',
  env: 'A command that sets environment variables runs after you check it.',
  notOwn: (command: string) => `${command} is not one of the agent’s scripts or a read-only command, so it runs after you check it.`,
  scriptMissing: (script: string) => `${script} was not found in the agent’s folder.`,
  outside: (path: string) => `${path} is outside the agent’s folder.`,
  protected: (path: string) => `${path} is in a protected part of the agent’s folder (credentials, .cinna, secrets).`,
  option: (command: string, option: string) => `${command} runs with ${option} only after you check it.`,
  needsPath: (command: string) => `${command} must name a file in the agent’s folder to read.`,
  searchRoot: (command: string) => `${command} must name a folder inside the agent’s folder to search, not the whole folder.`,
  tree: (path: string) => `${path} holds hidden or protected files, or too many to check.`
} as const

/** Why `word`, whose real path is `real`, is not readable (or writable) inside the folder, or null when it is. */
function pathRefusal(folder: string, real: string | null, word: string, mode: 'read' | 'write'): string | null {
  if (real === null) return OWN_COMMAND_REASONS.outside(word)
  const segments = segmentsIn(folder, real)
  if (segments === null) return OWN_COMMAND_REASONS.outside(word)
  return isProtected(segments, mode) ? OWN_COMMAND_REASONS.protected(word) : null
}

/* ----------------------------------------------------------------- commands */

/**
 * Whether `line`, run in `cwd`, is one simple command the agent may run
 * without asking: its own script (optionally under an interpreter), or one of
 * a few read-only basics on paths inside its folder. Fails closed: anything
 * it cannot parse, does not know, or cannot read answers false.
 *
 * The rule Antigravity's auto-approval settles `execute` asks by, and the one
 * a message's Run and Run in background are checked against before they run.
 */
export function ownCommandAllowed(
  policy: OwnCommandPolicy,
  cwd: string,
  line: string,
  fs: OwnCommandFs = nodeOwnCommandFs
): boolean {
  return ownCommandRefusal(policy, cwd, line, fs) === null
}

/**
 * {@link ownCommandAllowed} with the reason: null when the command passes,
 * else the sentence that says why not ({@link OWN_COMMAND_REASONS}).
 */
export function ownCommandRefusal(
  policy: OwnCommandPolicy,
  cwd: string,
  line: string,
  fs: OwnCommandFs = nodeOwnCommandFs
): string | null {
  try {
    if (typeof policy.folder !== 'string' || !isAbsolute(policy.folder)) return OWN_COMMAND_REASONS.unreadable
    if (typeof line !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd)) return OWN_COMMAND_REASONS.cwd
    const folder = fs.realpath(resolve(policy.folder))
    const realCwd = fs.realpath(resolve(cwd))
    const cwdSegments = segmentsIn(folder, realCwd)
    // A cwd in a protected folder (`credentials/`, `.cinna/`) would let `ls` list it.
    if (cwdSegments === null || isProtected(cwdSegments, 'read')) return OWN_COMMAND_REASONS.cwd
    const words = splitCommandLine(line)
    if (!words) return OWN_COMMAND_REASONS.notSimple
    if (words.length === 0) return OWN_COMMAND_REASONS.empty
    const [command] = words
    if (ENV_ASSIGNMENT.test(command)) return OWN_COMMAND_REASONS.env
    if (READ_ONLY_COMMANDS.has(command)) return readOnlyRefusal(folder, realCwd, command, words.slice(1), fs)
    return scriptRefusal(folder, realCwd, policy.scriptRoots, words, fs)
  } catch {
    return OWN_COMMAND_REASONS.unreadable
  }
}

/* ---------------------------------------------------------- the own script */

function scriptRefusal(folder: string, cwd: string, scriptRoots: readonly string[], words: string[], fs: OwnCommandFs): string | null {
  const word = scriptWord(words)
  if (word === null) return OWN_COMMAND_REASONS.notOwn(words[0])
  const real = realPathOf(resolve(cwd, word), fs)
  if (real === null || !fs.stat(real)?.isFile()) return OWN_COMMAND_REASONS.scriptMissing(word)
  const inFolder = segmentsIn(folder, real)
  if (inFolder !== null) return isProtected(inFolder, 'write') ? OWN_COMMAND_REASONS.protected(word) : null
  for (const root of scriptRoots) {
    if (typeof root !== 'string' || !isAbsolute(root)) continue
    let realRoot: string
    try { realRoot = fs.realpath(resolve(root)) } catch { continue }
    const segments = segmentsIn(realRoot, real)
    if (segments !== null && segments.length > 0 && !segments.some((s) => s === '.git' || secretName(s))) return null
  }
  return OWN_COMMAND_REASONS.outside(word)
}

/**
 * The real path of the script `word` names, run in `cwd`, when Cinna may read
 * it for its parameters: a file inside the agent's folder that is not
 * protected for a read (credentials, `.cinna/`, `.git/`, secret-looking
 * names), or a file under a pinned script root that is not in `.git` or
 * secret-looking. Null otherwise, and on any error. The same containment as
 * {@link scriptRefusal}, judged for reading rather than running. With the
 * path come the device and inode of the file judged, so the reader can
 * refuse a file it opens that is not that one (a parent directory swapped
 * for a symlink since); null when the filesystem gives none.
 */
export function readableOwnScript(
  policy: OwnCommandPolicy,
  cwd: string,
  word: string,
  fs: OwnCommandFs = nodeOwnCommandFs
): ReadableOwnScript | null {
  try {
    if (typeof policy.folder !== 'string' || !isAbsolute(policy.folder) || !isAbsolute(cwd)) return null
    const folder = fs.realpath(resolve(policy.folder))
    const real = realPathOf(resolve(cwd, word), fs)
    if (real === null) return null
    const stat = fs.stat(real)
    if (!stat?.isFile() || typeof stat.dev !== 'number' || typeof stat.ino !== 'number') return null
    const judged: ReadableOwnScript = { real, dev: stat.dev, ino: stat.ino }
    const inFolder = segmentsIn(folder, real)
    if (inFolder !== null) return isProtected(inFolder, 'read') ? null : judged
    for (const root of policy.scriptRoots) {
      if (typeof root !== 'string' || !isAbsolute(root)) continue
      let realRoot: string
      try { realRoot = fs.realpath(resolve(root)) } catch { continue }
      const segments = segmentsIn(realRoot, real)
      if (segments !== null && segments.length > 0 && !segments.some((s) => s === '.git' || secretName(s))) return judged
    }
    return null
  } catch {
    return null
  }
}

/* ------------------------------------------------------- read-only basics */

// The option tables and the shapes of a search and a `find` are shared with
// the menu's disk-free check (`shared/commandRun.ts`), so both refuse the same
// options.

/** How many entries a recursive search's tree may hold before Cinna stops looking and asks. */
const MAX_WALK = 5000

/**
 * Whether every entry under a search root is one Cinna would let the agent
 * read: nothing protected, and — where the search reads them — no hidden
 * entry. Symlinked directories are not followed (neither grep -r nor rg does);
 * a tree over {@link MAX_WALK} entries, or one that cannot be read, asks.
 */
function treeReadable(folder: string, root: string, hidden: boolean, fs: OwnCommandFs): boolean {
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
function searchRootRefusal(folder: string, cwd: string, command: string, root: string, hidden: boolean, fs: OwnCommandFs): string | null {
  const real = realPathOf(resolve(cwd, root), fs)
  const refused = pathRefusal(folder, real, root, 'read')
  if (refused !== null || real === null) return refused ?? OWN_COMMAND_REASONS.outside(root)
  if (real === folder) return OWN_COMMAND_REASONS.searchRoot(command)
  if (within(join(folder, 'credentials'), real) || within(join(folder, '.cinna'), real)) return OWN_COMMAND_REASONS.searchRoot(command)
  return treeReadable(folder, real, hidden, fs) ? null : OWN_COMMAND_REASONS.tree(root)
}

function searchRefusal(folder: string, cwd: string, command: 'grep' | 'rg', args: string[], fs: OwnCommandFs): string | null {
  const parsed = parseOptions(command === 'rg' ? RG_OPTIONS : GREP_OPTIONS, args)
  if ('bad' in parsed) return OWN_COMMAND_REASONS.option(command, parsed.bad)
  const { paths, recursive, hidden } = searchShape(command, parsed)
  if (!recursive) {
    if (paths.length === 0) return OWN_COMMAND_REASONS.needsPath(command)
    return firstRefusal(paths, (path) => pathRefusal(folder, realPathOf(resolve(cwd, path), fs), path, 'read'))
  }
  const roots = paths.length > 0 ? paths : ['.']
  return firstRefusal(roots, (root) => searchRootRefusal(folder, cwd, command, root, hidden, fs))
}

function firstRefusal(words: string[], check: (word: string) => string | null): string | null {
  for (const word of words) {
    const refused = check(word)
    if (refused !== null) return refused
  }
  return null
}

function readOnlyRefusal(folder: string, cwd: string, command: string, args: string[], fs: OwnCommandFs): string | null {
  if (command === 'grep' || command === 'rg') return searchRefusal(folder, cwd, command, args, fs)
  if (command === 'find') return findRefusal(folder, cwd, args, fs)
  const options = PLAIN_OPTIONS[command]
  if (!options) return OWN_COMMAND_REASONS.notOwn(command)
  const parsed = parseOptions(options, args)
  if ('bad' in parsed) return OWN_COMMAND_REASONS.option(command, parsed.bad)
  if (NEEDS_PATH.has(command) && parsed.positionals.length === 0) return OWN_COMMAND_REASONS.needsPath(command)
  return firstRefusal(parsed.positionals, (word) => pathRefusal(folder, realPathOf(resolve(cwd, word), fs), word, 'read'))
}

/**
 * `find` lists names, not contents, so it may start at the folder itself;
 * every start path must still be inside the folder and readable, and the
 * actions that run, delete or write are refused.
 */
function findRefusal(folder: string, cwd: string, args: string[], fs: OwnCommandFs): string | null {
  const shape = findShape(args)
  if ('bad' in shape) return OWN_COMMAND_REASONS.option('find', shape.bad)
  return firstRefusal(shape.starts, (start) => pathRefusal(folder, realPathOf(resolve(cwd, start), fs), start, 'read'))
}
