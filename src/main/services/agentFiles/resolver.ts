import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { isWithin } from '../localAgents/pathRules'
import {
  MAX_FILE_REF_BASES,
  MAX_FILE_REF_CANDIDATES,
  fileRefCandidatePath,
  type AgentFileRef,
  type AgentFileRefKind
} from '../../../shared/agentFiles'
import { createPathCanonicalizer, type PathCanonicalizer } from './canonicalPath'

interface Hit {
  real: string
  kind: AgentFileRefKind
}

export interface ResolveFileRefsOptions {
  /** Where `~/` points. Injected so tests do not depend on the real home. */
  home?: string
  maxCandidates?: number
  maxBases?: number
  /**
   * `isGuardedLocation`: whether touching a path raises a macOS privacy
   * prompt. Required so no caller can forget it; the resolver runs when a chat
   * opens, and a prompt then would follow no click.
   */
  isGuarded: (path: string) => boolean
  paths?: PathCanonicalizer
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/** How a path outside an agent folder is shown: `~/…` under the home, else absolute. */
export function homeDisplayPath(real: string, realHome: string): string {
  if (realHome && real === realHome) return '~'
  if (realHome && isWithin(realHome, real)) return `~/${toPosix(relative(realHome, real))}`
  return real
}

/** How a resolved path is shown: agent-relative inside, `~/…` or absolute outside. */
export function displayPathFor(real: string, realAgentDir: string, realHome: string): string {
  if (isWithin(realAgentDir, real)) return toPosix(relative(realAgentDir, real)) || '.'
  return homeDisplayPath(real, realHome)
}

/**
 * Which inline code spans name a real file or folder, for one agent.
 *
 * Detection only stats: nothing is read, and a path outside the folder is
 * linked here and gated later, when the user acts on it.
 *
 * 1. **Direct** — absolute as is, `~/…` against the home, relative against the
 *    agent folder.
 * 2. **Bases** — a relative span without `..` that missed is tried against the
 *    folders earlier refs live in: each file's parent, each folder, and their
 *    ancestors while still strictly inside the agent folder (an outside ref
 *    contributes only its own folder). It links only when exactly one distinct
 *    realpath matches, so `summary.md` next to two different earlier files
 *    stays plain text. Only *earlier* spans contribute and the base list keeps
 *    its first entries when capped, so a link never disappears when a later
 *    message arrives.
 *
 * **Opening a chat must not raise a macOS privacy prompt.** A path under a
 * guarded folder (`~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive) is
 * never probed unless the agent folder is inside that same guarded folder, and
 * a ref that lands in one anyway (through a symlink) contributes no bases.
 *
 * Every path in a ref is a canonical realpath, and `inside` is decided on those.
 */
export async function resolveFileRefs(
  agentDir: string,
  candidates: readonly unknown[],
  options: ResolveFileRefsOptions
): Promise<AgentFileRef[]> {
  const home = options.home ?? homedir()
  const maxCandidates = options.maxCandidates ?? MAX_FILE_REF_CANDIDATES
  const maxBases = options.maxBases ?? MAX_FILE_REF_BASES
  const paths = options.paths ?? createPathCanonicalizer()

  let realAgentDir: string
  try {
    realAgentDir = await paths.realpath(agentDir)
  } catch {
    return []
  }
  const realHome = await paths.realpath(home).catch(() => resolve(home))

  /** The guarded folder a path sits in (the outermost guarded ancestor), or null. */
  const guardedRootOf = (path: string): string | null => {
    let current = paths.lexical(path)
    if (!options.isGuarded(current)) return null
    for (;;) {
      const parent = dirname(current)
      if (parent === current || !options.isGuarded(parent)) return current
      current = parent
    }
  }
  const agentSpellings = [paths.lexical(resolve(agentDir)), paths.lexical(realAgentDir)]
  const offLimits = (path: string): boolean => {
    const root = guardedRootOf(path)
    return root !== null && !agentSpellings.some((dir) => isWithin(root, dir))
  }

  // One stat per distinct path per call: the base heuristic retries the same
  // joins across candidates.
  const probes = new Map<string, Promise<Hit | null>>()
  const probe = (path: string): Promise<Hit | null> => {
    let pending = probes.get(path)
    if (!pending) {
      pending = (async () => {
        if (offLimits(path)) return null
        try {
          const real = await paths.realpath(path)
          const info = await stat(real)
          if (info.isDirectory()) return { real, kind: 'dir' as const }
          if (info.isFile()) return { real, kind: 'file' as const }
          return null
        } catch {
          return null
        }
      })()
      probes.set(path, pending)
    }
    return pending
  }

  const bases: string[] = []
  const baseSet = new Set<string>()
  const addBase = (dir: string): void => {
    if (bases.length >= maxBases || baseSet.has(dir)) return
    baseSet.add(dir)
    bases.push(dir)
  }

  const refs: AgentFileRef[] = []
  const seen = new Set<string>()
  let considered = 0
  for (const text of candidates) {
    if (considered >= maxCandidates) break
    if (typeof text !== 'string' || seen.has(text)) continue
    const candidate = fileRefCandidatePath(text)
    if (candidate === null) continue
    seen.add(text)
    considered += 1

    let hit: Hit | null
    if (candidate.startsWith('~/')) {
      hit = await probe(join(home, candidate.slice(2)))
    } else if (isAbsolute(candidate)) {
      hit = await probe(normalize(candidate))
    } else {
      hit = await probe(resolve(agentDir, candidate))
      if (!hit && bases.length > 0 && !candidate.split('/').includes('..')) {
        const hits = await Promise.all(bases.map((base) => probe(join(base, candidate))))
        const distinct = new Map<string, Hit>()
        for (const found of hits) if (found) distinct.set(found.real, found)
        if (distinct.size === 1) hit = [...distinct.values()][0]
      }
    }
    if (!hit) continue

    const inside = isWithin(realAgentDir, hit.real)
    refs.push({
      text,
      path: hit.real,
      displayPath: displayPathFor(hit.real, realAgentDir, realHome),
      kind: hit.kind,
      inside
    })

    const own = hit.kind === 'dir' ? hit.real : dirname(hit.real)
    if (offLimits(own)) continue
    if (!inside) {
      addBase(own)
      continue
    }
    for (let dir = own; dir !== realAgentDir && isWithin(realAgentDir, dir); ) {
      addBase(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return refs
}
