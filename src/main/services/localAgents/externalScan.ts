/**
 * Finding agents in a folder that knows nothing about the kit.
 *
 * The rule is one file: a directory holding an `AGENT.md`, `AGENTS.md` or
 * `CLAUDE.md` is an agent, and the first of those it has is its instructions.
 * That is the whole contract for a **bare** agent — no manifest, no layout, no
 * version — which is the point: any folder a person already works in becomes
 * something the desktop can run without being converted first. The two weak
 * names carry two guards, described at {@link resolveBareInstructionsFile} and
 * {@link discoverBareAgents}.
 *
 * Nothing here writes. A folder the user points at is read and reported; the
 * only thing that ever lands on disk for a bare agent is its state file, and
 * that lives under `userData` (see `desktopStateService`).
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { MANIFEST_FILE } from '../../../shared/kit/manifest'
import {
  BARE_AGENT_INSTRUCTION_FILES,
  BARE_AGENT_MAX_DEPTH,
  BARE_AGENT_README_FILE,
  type BareInstructionsFile
} from '../../../shared/localAgents'

/**
 * Directories the walk never descends into.
 *
 * Not an optimisation. A dependency tree is exactly where a stray `AGENT.md`
 * belonging to somebody else's package lives, and offering the user fifteen
 * agents out of `node_modules` would make the picker useless the one time it
 * mattered. Dot-directories are skipped separately — that covers `.git`,
 * `.venv`, `.idea` and every editor's bookkeeping.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'venv',
  'env',
  '__pycache__',
  'site-packages',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'Pods',
  'bower_components'
])

/**
 * The kit's contract copy inside a workshop root. Its presence — like a
 * `cinna-agent.json` — marks a folder whose `AGENTS.md` / `CLAUDE.md` the kit
 * scaffolded, so neither is read as a bare agent's instructions there.
 */
export const KIT_WORKSHOP_DIR = '.cinna-kit'

/**
 * The strong instructions file. A folder holding it is an agent however the
 * tree around it looks; the other two names only count where no `AGENT.md`
 * folder sits below them.
 */
const STRONG_INSTRUCTIONS_FILE: BareInstructionsFile = 'AGENT.md'

/**
 * Most agents one folder may yield.
 *
 * A guard against a folder that is not what the user thought it was — a home
 * directory, a monorepo — rather than a design limit. Hitting it is reported,
 * so the dialog can say the list is partial instead of quietly truncating.
 */
export const MAX_DISCOVERED_AGENTS = 200

/** Longest prefix of the instructions file read to find a heading. */
const NAME_PROBE_BYTES = 4096

function isFileAt(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectoryAt(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * True for a folder the kit made: one holding `cinna-agent.json`, or a
 * `.cinna-kit/` directory. The kit scaffolds `AGENTS.md` and `CLAUDE.md` into
 * every agent and workshop root, so in such a folder those two say nothing
 * about a bare agent.
 */
function isKitShapedDir(dir: string): boolean {
  return kitFolderShape(dir) !== null
}

/**
 * Which kit folder this is, if any: a kit **agent** (`cinna-agent.json`) or a
 * **workshop** root (`.cinna-kit/`). Exported for the pick's refusal, which
 * has to say why the `AGENTS.md` and `CLAUDE.md` it can see did not count.
 */
export function kitFolderShape(dir: string): 'agent' | 'workshop' | null {
  if (isFileAt(join(dir, MANIFEST_FILE))) return 'agent'
  if (isDirectoryAt(join(dir, KIT_WORKSHOP_DIR))) return 'workshop'
  return null
}

/**
 * The instructions file this directory would be a bare agent by: the first of
 * {@link BARE_AGENT_INSTRUCTION_FILES} it holds as a **file**, or null.
 *
 * `AGENTS.md` and `CLAUDE.md` do not count in a kit-shaped folder
 * ({@link isKitShapedDir}) — counting them would demote every kit agent in an
 * adopted tree to a bare one, losing its commands, credential slots and
 * declared runtime. `AGENT.md` counts wherever it is, as it always has.
 *
 * Only the folder itself is considered; whether a weak match makes the folder
 * an agent also depends on what is below it, which is the walk's call.
 */
export function resolveBareInstructionsFile(dir: string): BareInstructionsFile | null {
  let kitShaped: boolean | null = null
  for (const file of BARE_AGENT_INSTRUCTION_FILES) {
    if (!isFileAt(join(dir, file))) continue
    if (file === STRONG_INSTRUCTIONS_FILE) return file
    kitShaped ??= isKitShapedDir(dir)
    return kitShaped ? null : file
  }
  return null
}

/** True when this directory holds an instructions file that counts here. */
export function isBareAgentDir(dir: string): boolean {
  return resolveBareInstructionsFile(dir) !== null
}

/**
 * The default display name for a bare agent folder.
 *
 * The first markdown H1 in its instructions file, because that is what the
 * author already wrote the agent's name into; the folder name when there is
 * none. Never throws — a folder that cannot be read still has a basename, and
 * a nameless row in the picker would be worse than a directory name.
 *
 * Only the head of the file is read: an instructions file can be tens of
 * kilobytes, and a heading that is not in the first few lines is not a title.
 */
export function readBareAgentName(
  dir: string,
  file: BareInstructionsFile | null = resolveBareInstructionsFile(dir)
): string {
  const fallback = basename(dir)
  if (file === null) return fallback
  let head: string
  try {
    head = readFileSync(join(dir, file), 'utf8').slice(0, NAME_PROBE_BYTES)
  } catch {
    return fallback
  }
  // `# CLAUDE.md` is a very common first line, and it names the file rather
  // than the agent — a sidebar of rows all called "CLAUDE.md" says nothing.
  const ownName = file.toLowerCase()
  const fileNames = new Set([ownName, ownName.replace(/\.md$/, '')])
  for (const line of head.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const title = match[1].trim()
    // A heading longer than a name is a sentence — the file opens with prose
    // under a `#` rather than with a title. The folder name is the better
    // answer there, and it is the one the user can see in the path beside it.
    if (title !== '' && title.length <= 80 && !fileNames.has(title.toLowerCase())) return title
    break
  }
  return fallback
}

/** One folder found by {@link discoverBareAgents}. */
export interface DiscoveredFolder {
  /** Root-relative POSIX path; `'.'` when the walked folder is itself an agent. */
  relPath: string
  path: string
  name: string
  /** The instructions file that made this folder an agent. */
  instructionsFile: BareInstructionsFile
  hasReadme: boolean
}

/**
 * The directories the walk may enter below `dir`, sorted by name: no
 * dot-directories, nothing in {@link SKIP_DIRS}, symlinks followed. Empty for
 * a directory that cannot be listed.
 */
function childDirectories(dir: string): string[] {
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    // `withFileTypes` reports a symlink as a symlink rather than as what it
    // points at, so stat it — a folder of agents assembled out of links is
    // exactly the shape someone curating a set would build.
    if (isDirectoryAt(full)) dirs.push(full)
  }
  return dirs
}

/**
 * Walk `rootPath` for folders holding an instructions file.
 *
 * Depth 0 is `rootPath` itself, so the two shapes the user cares about are the
 * same walk: a single agent folder (found at depth 0) and a repository of them
 * (`<repo>/local_agents/<agent>`, found at depth 2).
 *
 * **A folder that is an agent is not descended into.** An agent's own working
 * tree very often holds sub-projects with their own instructions — a nested
 * one is part of that agent, not a sibling of it — and descending would list
 * the same work twice under two names the user cannot tell apart.
 *
 * **An `AGENT.md` below a weak match wins over it.** A folder whose file is
 * `AGENTS.md` or `CLAUDE.md` is an agent only when no `AGENT.md` folder sits
 * below it within the walk's reach; otherwise it is walked like any other
 * folder, and the same rule applies again to what is under it. Team
 * repositories of `local_agents/<x>/AGENT.md` very often carry a root
 * `CLAUDE.md` for the people working on them, and reading that root as the
 * one agent would, on the next rescan of a root already registered, prune
 * every agent adopted from it — and their sessions with them.
 *
 * **Unless it is already an agent.** `options.keep` answers that for the one
 * folder the previous rule would demote: a weak folder with an `AGENT.md`
 * below it. The user already adopted it, chatted with it or hid it, so an
 * `AGENT.md` arriving underneath (one `git pull` away) must not turn it into a
 * container, which would prune its row and cascade its sessions away. A kept
 * folder is an agent like any other, so the walk does not descend into it.
 * `keep` is asked about nothing else — not a strong folder, and not a weak one
 * with nothing strong below — so the common path never pays for it.
 *
 * Never throws: an unreadable directory contributes nothing and the walk
 * continues, because one permission-denied subfolder must not take the whole
 * pick with it.
 */
export function discoverBareAgents(
  rootPath: string,
  maxDepth: number = BARE_AGENT_MAX_DEPTH,
  options: {
    withNames?: boolean
    limit?: number
    /** True for a weak folder that stays an agent whatever is below it. */
    keep?: (absPath: string) => boolean
  } = {}
): { found: DiscoveredFolder[]; truncated: boolean } {
  // `withNames: false` is for the callers that only need to *count* — the
  // settings screen's per-root agent count, which is rebuilt on every
  // `local-agent:list`. Reading each folder's instructions head and probing for
  // a `README.md` there would put one file read per agent on the main thread on
  // every push from the watcher, which is exactly the compounding the scan
  // cache exists to avoid.
  const withNames = options.withNames !== false
  // Injected only so the cap's *reporting* can be asserted without building two
  // hundred folders; production always takes the constant. **Clamped**, so the
  // seam can only ever narrow the cap — a caller that passed a larger number
  // cannot quietly raise it, which is the one way a test-only parameter turns
  // into a production behaviour.
  const limit = Math.min(options.limit ?? MAX_DISCOVERED_AGENTS, MAX_DISCOVERED_AGENTS)
  const found: DiscoveredFolder[] = []
  let truncated = false

  const describe = (dir: string, file: BareInstructionsFile): DiscoveredFolder => {
    const rel = relative(rootPath, dir).split(sep).join('/')
    return {
      relPath: rel === '' ? '.' : rel,
      path: dir,
      name: withNames ? readBareAgentName(dir, file) : basename(dir),
      instructionsFile: file,
      hasReadme: withNames ? existsSync(join(dir, BARE_AGENT_README_FILE)) : false
    }
  }

  // Whether an `AGENT.md` folder sits anywhere below `dir` that the walk could
  // reach from it. A read-only probe: it adds nothing to `found`, so it never
  // counts toward the cap or `truncated`.
  const hasStrongAgentBelow = (dir: string, depth: number): boolean => {
    if (depth >= maxDepth) return false
    for (const child of childDirectories(dir)) {
      if (isFileAt(join(child, STRONG_INSTRUCTIONS_FILE))) return true
      if (hasStrongAgentBelow(child, depth + 1)) return true
    }
    return false
  }

  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit) {
      truncated = true
      return
    }
    const file = resolveBareInstructionsFile(dir)
    // Order matters: `keep` is consulted last, so only for a weak folder that
    // the probe below would otherwise demote.
    if (
      file !== null &&
      (file === STRONG_INSTRUCTIONS_FILE ||
        !hasStrongAgentBelow(dir, depth) ||
        options.keep?.(dir) === true)
    ) {
      found.push(describe(dir, file))
      return
    }
    if (depth >= maxDepth) return
    for (const child of childDirectories(dir)) walk(child, depth + 1)
  }

  walk(rootPath, 0)
  found.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { found, truncated }
}
