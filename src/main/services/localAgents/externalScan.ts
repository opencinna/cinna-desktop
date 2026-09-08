/**
 * Finding agents in a folder that knows nothing about the kit.
 *
 * The rule is one file: a directory holding an `AGENT.md` is an agent. That is
 * the whole contract for a **bare** agent — no manifest, no layout, no version
 * — which is the point: any folder a person already works in becomes something
 * the desktop can run without being converted first.
 *
 * Nothing here writes. A folder the user points at is read and reported; the
 * only thing that ever lands on disk for a bare agent is its state file, and
 * that lives under `userData` (see `desktopStateService`).
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import {
  BARE_AGENT_MAX_DEPTH,
  BARE_AGENT_PROMPT_FILE,
  BARE_AGENT_README_FILE
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
 * Most agents one folder may yield.
 *
 * A guard against a folder that is not what the user thought it was — a home
 * directory, a monorepo — rather than a design limit. Hitting it is reported,
 * so the dialog can say the list is partial instead of quietly truncating.
 */
export const MAX_DISCOVERED_AGENTS = 200

/** Longest prefix of `AGENT.md` read to find a heading. */
const NAME_PROBE_BYTES = 4096

/** True when this directory is a bare agent: it holds an `AGENT.md` file. */
export function isBareAgentDir(dir: string): boolean {
  try {
    return statSync(join(dir, BARE_AGENT_PROMPT_FILE)).isFile()
  } catch {
    return false
  }
}

/**
 * The default display name for a bare agent folder.
 *
 * The first markdown H1 in `AGENT.md`, because that is what the author already
 * wrote the agent's name into; the folder name when there is none. Never
 * throws — a folder that cannot be read still has a basename, and a nameless
 * row in the picker would be worse than a directory name.
 *
 * Only the head of the file is read: an `AGENT.md` can be tens of kilobytes,
 * and a heading that is not in the first few lines is not a title.
 */
export function readBareAgentName(dir: string): string {
  const fallback = basename(dir)
  let head: string
  try {
    head = readFileSync(join(dir, BARE_AGENT_PROMPT_FILE), 'utf8').slice(0, NAME_PROBE_BYTES)
  } catch {
    return fallback
  }
  for (const line of head.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const title = match[1].trim()
    // A heading longer than a name is a sentence — the file opens with prose
    // under a `#` rather than with a title. The folder name is the better
    // answer there, and it is the one the user can see in the path beside it.
    if (title !== '' && title.length <= 80) return title
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
  hasReadme: boolean
}

/**
 * Walk `rootPath` for folders holding an `AGENT.md`.
 *
 * Depth 0 is `rootPath` itself, so the two shapes the user cares about are the
 * same walk: a single agent folder (found at depth 0) and a repository of them
 * (`<repo>/local_agents/<agent>`, found at depth 2).
 *
 * **A folder that is an agent is not descended into.** An agent's own working
 * tree very often holds sub-projects with their own `AGENT.md` — a nested one
 * is part of that agent, not a sibling of it — and descending would list the
 * same work twice under two names the user cannot tell apart.
 *
 * Never throws: an unreadable directory contributes nothing and the walk
 * continues, because one permission-denied subfolder must not take the whole
 * pick with it.
 */
export function discoverBareAgents(
  rootPath: string,
  maxDepth: number = BARE_AGENT_MAX_DEPTH,
  options: { withNames?: boolean; limit?: number } = {}
): { found: DiscoveredFolder[]; truncated: boolean } {
  // `withNames: false` is for the callers that only need to *count* — the
  // settings screen's per-root agent count, which is rebuilt on every
  // `local-agent:list`. Reading each folder's `AGENT.md` head and probing for a
  // `README.md` there would put one file read per agent on the main thread on
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

  const describe = (dir: string): DiscoveredFolder => {
    const rel = relative(rootPath, dir).split(sep).join('/')
    return {
      relPath: rel === '' ? '.' : rel,
      path: dir,
      name: withNames ? readBareAgentName(dir) : basename(dir),
      hasReadme: withNames ? existsSync(join(dir, BARE_AGENT_README_FILE)) : false
    }
  }

  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit) {
      truncated = true
      return
    }
    if (isBareAgentDir(dir)) {
      found.push(describe(dir))
      return
    }
    if (depth >= maxDepth) return

    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      // `withFileTypes` reports a symlink as a symlink rather than as what it
      // points at, so stat it — a folder of agents assembled out of links is
      // exactly the shape someone curating a set would build.
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      walk(full, depth + 1)
    }
  }

  walk(rootPath, 0)
  found.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { found, truncated }
}
