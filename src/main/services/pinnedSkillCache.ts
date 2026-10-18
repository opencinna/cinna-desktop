/**
 * The machinery both pinned-skill caches share — catalog skills
 * (`catalogSkillCache.ts`) and marketplace skills (`marketplaceSkillCache.ts`):
 * `<userData>/<dir>/<instance>/<uuid>/<key>/<name>/`, where `<key>` is the
 * catalog revision number or the marketplace snapshot's digest.
 *
 * * **Shared across agents.** Two agents pinning one `<key>` use one folder;
 *   nothing in it is an agent's.
 * * **Read-only.** Files 0444 (0555 when the archive marked them executable),
 *   folders 0555 — an engine or an assistant reading a skill cannot edit the
 *   copy every other agent uses.
 * * **Complete or absent.** A `<key>` folder is unpacked into a staging folder
 *   beside it, with a marker naming what it holds, and renamed into place in
 *   one step. A `<key>` folder without a marker that matches the pin is not a
 *   cached skill.
 * * **Per instance.** `<instance>` is a filesystem-safe key of the Cinna
 *   server ({@link instanceKey}). A lookup prefers the active profile's
 *   instance and then tries the others — a pin names a uuid and an archive
 *   digest, not a server, and an agent folder is not tied to one profile — but
 *   only a marker whose digest equals the pin's counts.
 *
 * Each kind supplies how a pin becomes safe path components and what its
 * marker holds; the folder walking, staging, locking and garbage collection
 * are here, once. The last failed download of each pin is kept in memory for
 * the Skills section's issue; a restart forgets it.
 *
 * Core: no Electron. Paths come from `runtimeHost`.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { getProfileScopeUserId } from '../auth/scope'
import { libraryService } from './libraryService'
import { createLogger, type ScopedLogger } from '../logger/logger'
import { writeSkillTree, type SkillArchive } from '../kit/skillArchive'
import type { CatalogSkillCacheState } from '../kit/skills'

/** For {@link removeTree} called outside a cache; each cache logs under its kind's own name. */
const defaultLogger = createLogger('pinned-skill-cache')

/** A staging folder older than this belongs to no install still running. */
const STALE_STAGING_MS = 10 * 60 * 1000

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const SHA256_RE = /^[0-9a-f]{64}$/

/**
 * A pin as safe path components: `uuid` and `key` name the folder
 * (`<uuid>/<key>`), `name` the skill folder inside it, `sha` the digest the
 * marker must hold.
 */
export interface SafePin {
  uuid: string
  key: string
  name: string
  sha: string
}

/**
 * A server origin as one folder name: `https://cinna.example.com:8443` →
 * `https-cinna.example.com-8443`. Lowercase, `[a-z0-9.-]` only.
 */
export function instanceKey(origin: string): string {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return origin.toLowerCase().replace(/[^a-z0-9.-]+/g, '_').slice(0, 200) || 'unknown'
  }
  const parts = [url.protocol.replace(/:$/, ''), url.hostname, url.port].filter((part) => part !== '')
  return parts.join('-').toLowerCase().replace(/[^a-z0-9.-]+/g, '_')
}

/** The active profile's instance key, or null without a Cinna profile. */
export function activeInstance(): string | null {
  try {
    const host = libraryService.hostOf(getProfileScopeUserId())
    return host === null ? null : instanceKey(host)
  } catch {
    return null
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Whether `path` is a real folder: there, a directory, and not a link to one. */
function isRealDir(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The folders from the cache root down to `dir`, root first, or null when
 * `dir` is not under the root. Every one is checked with `lstat`: a link
 * anywhere in the chain would make the cache read, or write, somewhere else.
 */
function chainFrom(root: string, dir: string): string[] | null {
  const rel = relative(root, dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  const chain = [root]
  for (const part of rel.split(sep)) chain.push(join(chain[chain.length - 1], part))
  return chain
}

/**
 * Make a tree writable again and remove it. Never follows a link; best effort
 * (an undeletable leftover is swept on a later install). `label` and `log` name
 * the cache in the warning.
 */
export function removeTree(path: string, label = 'cached skill', log: ScopedLogger = defaultLogger): void {
  const unlock = (dir: string): void => {
    try {
      chmodSync(dir, 0o755)
    } catch {
      return
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) unlock(join(dir, entry.name))
  }
  try {
    const stat = lstatSync(path)
    if (stat.isDirectory()) unlock(path)
    rmSync(path, { recursive: true, force: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.warn(`could not remove a ${label} folder`, { path, error: String(err) })
    }
  }
}

/** Whether a staging folder (`<key>.tmp-…`, `.old-…`) is old enough to belong to no install still running. */
function staleStaging(path: string, now: number): boolean {
  try {
    return now - lstatSync(path).mtimeMs >= STALE_STAGING_MS
  } catch {
    return false
  }
}

/** The real folders in `dir` to walk; a link is removed as a link, and `.`-names are left alone. */
function realChildren(dir: string, onRemoved: () => void, remove: (path: string) => void): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) {
      remove(join(dir, entry.name))
      onRemoved()
    } else if (entry.isDirectory()) {
      out.push(entry.name)
    }
  }
  return out
}

/** Remove `dir` when nothing is left in it. */
function removeIfEmpty(dir: string, remove: (path: string) => void): void {
  try {
    if (readdirSync(dir).length === 0) remove(dir)
  } catch {
    /* gone already, or unreadable: left for the next run */
  }
}

function sweepStaging(parent: string, key: string, remove: (path: string) => void): void {
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith(`${key}.tmp-`) && !name.startsWith(`${key}.old-`)) continue
    const path = join(parent, name)
    try {
      if (now - statSync(path).mtimeMs < STALE_STAGING_MS) continue
    } catch {
      continue
    }
    remove(path)
  }
}

/** A failure record: a sentence that is the same for every agent, or the agent-independent 404. */
type FailureRecord = { kind: 'message'; message: string } | { kind: 'not_available' }

/** What one kind of pinned skill tells the shared machinery. */
export interface PinnedSkillCacheKind<Ref, Extra extends object = object> {
  /** The folder under `userData`: `catalog-skills`, `marketplace-skills`. */
  dir: string
  /** The marker file in each `<key>` folder. */
  markerFile: string
  /** For log lines: `catalog skill`, `marketplace skill`. */
  label: string
  /** The logger's name: `catalog-skill-cache`, `marketplace-skill-cache`. */
  logger: string
  /** The log field naming a `<key>`: `revision`, `sha256`. */
  keyField: string
  /** What a `<key>` folder is called in log lines, plural: `revisions`, `snapshots`. */
  keyNoun: string
  /** The pin's fields as safe path components, or null when one is not. */
  safe(ref: Ref): SafePin | null
  /** The marker written beside a freshly unpacked skill. */
  marker(safe: SafePin, ref: Ref & Partial<Extra>): Record<string, unknown>
  /** Whether a marker read from disk is the pin's (its digest is compared already). */
  markerMatches(marker: Record<string, unknown>, safe: SafePin): boolean
  /** The sentence for a recorded 404, by whether a team tracks the asking agent. */
  notAvailableSentence(teamTracked: boolean): string
}

/** A pinned-skill cache over one {@link PinnedSkillCacheKind}. */
export function createPinnedSkillCache<Ref, Extra extends object = object>(kind: PinnedSkillCacheKind<Ref, Extra>) {
  let rootOverride: string | null = null
  const failures = new Map<string, FailureRecord>()
  const logger = createLogger(kind.logger)
  const remove = (path: string): void => removeTree(path, kind.label, logger)

  const cacheRoot = (): string | null => {
    if (rootOverride) return rootOverride
    try {
      return join(runtimeHost.getPath('userData'), kind.dir)
    } catch {
      return null
    }
  }

  /**
   * A failure belongs to one pin's check, so the digest is part of the key: a
   * mismatch on one pin must never mark another pin of the same `<key>` failed.
   */
  const failureKey = (safe: SafePin): string => `${safe.uuid}/${safe.key}/${safe.sha}`

  const readMarker = (keyDir: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(readFileSync(join(keyDir, kind.markerFile), 'utf8')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  /** The skill folder in `keyDir` when its marker matches the pin. */
  const readyDir = (keyDir: string, safe: SafePin): string | null => {
    // A linked `<uuid>` or `<key>` folder is not a cached skill, whatever its marker says.
    const root = cacheRoot()
    const chain = root === null ? null : chainFrom(root, keyDir)
    if (chain === null || !chain.every(isRealDir)) return null
    const marker = readMarker(keyDir)
    if (!marker) return null
    if (typeof marker.archive_sha256 !== 'string' || marker.archive_sha256.toLowerCase() !== safe.sha) return null
    if (marker.name !== safe.name || !kind.markerMatches(marker, safe)) return null
    const dir = join(keyDir, safe.name)
    try {
      const stat = lstatSync(dir)
      return stat.isDirectory() && !stat.isSymbolicLink() ? dir : null
    } catch {
      return null
    }
  }

  const keyDirOf = (instance: string, ref: Ref): string | null => {
    const root = cacheRoot()
    const safe = kind.safe(ref)
    if (root === null || safe === null) return null
    return join(root, instance, safe.uuid, safe.key)
  }

  /** A lookup, with a 404 worded for an agent that is (or is not) team-tracked. */
  const lookup = (ref: Ref, teamTracked: boolean): CatalogSkillCacheState => {
    const safe = kind.safe(ref)
    const root = cacheRoot()
    if (safe === null || root === null) return { state: 'missing' }
    const active = activeInstance()
    const instances: string[] = active ? [active] : []
    try {
      for (const name of readdirSync(root)) if (name !== active && !name.startsWith('.')) instances.push(name)
    } catch {
      /* no cache yet */
    }
    for (const instance of instances) {
      const dir = readyDir(join(root, instance, safe.uuid, safe.key), safe)
      if (dir) return { state: 'ready', dir }
    }
    const failure = failures.get(failureKey(safe))
    if (!failure) return { state: 'missing' }
    return { state: 'failed', message: failure.kind === 'message' ? failure.message : kind.notAvailableSentence(teamTracked) }
  }

  const cache = {
    instanceKey,
    activeInstance,

    /** The cache's root folder (`<userData>/<dir>`), or null on a host without `userData`. */
    root(): string | null {
      return cacheRoot()
    },

    /** The `<key>` folder a pin would be cached in on `instance`, or null for an unusable pin. */
    revisionDir(instance: string, ref: Ref): string | null {
      return keyDirOf(instance, ref)
    },

    /**
     * Where a pin stands on this computer: `ready` with its skill folder,
     * `failed` with the last download's sentence, or `missing`. A 404 reads as
     * for a team-tracked agent (the hedged sentence); a row of a known agent
     * words it through {@link resolverFor}. Never throws.
     */
    resolve(ref: Ref): CatalogSkillCacheState {
      return lookup(ref, true)
    },

    /** {@link resolve} for one agent: a recorded 404 reads as that agent's sentence. */
    resolverFor(teamTracked: boolean): (ref: Ref) => CatalogSkillCacheState {
      return (ref) => lookup(ref, teamTracked)
    },

    /**
     * The cache instance a path inside the cache belongs to (its first folder
     * under the root), or null for a path outside it.
     */
    instanceOfPath(path: string): string | null {
      const root = cacheRoot()
      if (root === null || !path) return null
      const rel = relative(root, path)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
      const first = rel.split(sep)[0]
      return first && !first.startsWith('.') ? first : null
    },

    /** Whether `instance` already holds the pin. */
    has(instance: string, ref: Ref): boolean {
      const safe = kind.safe(ref)
      const dir = keyDirOf(instance, ref)
      return safe !== null && dir !== null && readyDir(dir, safe) !== null
    },

    /**
     * Put a checked archive into the cache as the pin, atomically: staged
     * beside its final place, marked, renamed in. A folder already there with
     * the pin's digest is kept. Answers the skill folder.
     *
     * @throws Error when the pin is unusable or the disk refuses; nothing is left at the final path then.
     */
    install(instance: string, ref: Ref & Partial<Extra>, archive: SkillArchive): string {
      const safe = kind.safe(ref)
      const finalDir = keyDirOf(instance, ref)
      if (safe === null || finalDir === null) throw new Error('This pin cannot be cached.')
      const parent = join(finalDir, '..')
      const root = cacheRoot()
      const chain = root === null ? null : chainFrom(root, parent)
      if (root === null || chain === null) throw new Error('This pin cannot be cached.')
      // Folder by folder, never through a link: `mkdirSync(recursive)` would
      // follow a linked `<instance>` or `<uuid>` folder and write wherever it points.
      mkdirSync(dirname(root), { recursive: true })
      for (const dir of chain) {
        try {
          mkdirSync(dir)
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
        }
        if (!isRealDir(dir)) throw new Error(`The ${kind.label} cache holds a link where a folder should be.`)
      }
      sweepStaging(parent, safe.key, remove)
      const existing = readyDir(finalDir, safe)
      if (existing) return existing

      const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
      // Something at the final path that is not this pin (no marker, or
      // another digest) is moved aside first, so the rename below can land.
      // `lstat`, not `exists`: a link there (even a dangling one) is moved aside, never followed.
      if (lexists(finalDir)) {
        const aside = join(parent, `${safe.key}.old-${stamp}`)
        renameSync(finalDir, aside)
        remove(aside)
      }
      const staging = join(parent, `${safe.key}.tmp-${stamp}`)
      try {
        mkdirSync(staging)
        writeSkillTree(join(staging, safe.name), archive)
        writeFileSync(join(staging, kind.markerFile), `${JSON.stringify(kind.marker(safe, ref), null, 2)}\n`, { mode: 0o444 })
        try {
          renameSync(staging, finalDir)
        } catch (err) {
          // Another install of the same pin landed first: theirs stands.
          const landed = readyDir(finalDir, safe)
          if (!landed) throw err
          remove(staging)
          return landed
        }
      } catch (err) {
        remove(staging)
        throw err
      }
      failures.delete(failureKey(safe))
      logger.info(`${kind.label} cached`, { name: safe.name, [kind.keyField]: safe.key })
      return join(finalDir, safe.name)
    },

    /** Remember why the last download of a pin failed, for the Skills section. */
    recordFailure(ref: Ref, message: string): void {
      const safe = kind.safe(ref)
      if (safe) failures.set(failureKey(safe), { kind: 'message', message })
    },

    /** Remember that the last download of a pin was refused as not available (404), worded per agent. */
    recordNotAvailable(ref: Ref): void {
      const safe = kind.safe(ref)
      if (safe) failures.set(failureKey(safe), { kind: 'not_available' })
    },

    /**
     * Whether the last download of `<uuid>/<key>` was refused as not
     * available (404), whichever pin (digest) asked. In memory only.
     */
    notAvailableAt(uuid: string, key: string): boolean {
      const prefix = `${uuid.trim().toLowerCase()}/${key}/`
      for (const [failure, record] of failures) if (record.kind === 'not_available' && failure.startsWith(prefix)) return true
      return false
    },

    clearFailure(ref: Ref): void {
      const safe = kind.safe(ref)
      if (safe) failures.delete(failureKey(safe))
    },

    /**
     * Whether there is nothing for {@link collectGarbage} to look at: no cache
     * folder, or none but `.`-names in it. Lets a start without a cache skip
     * reading every agent's pins.
     */
    isEmpty(): boolean {
      const root = cacheRoot()
      if (root === null || !isRealDir(root)) return true
      try {
        return readdirSync(root).every((name) => name.startsWith('.'))
      } catch {
        return true
      }
    },

    /**
     * Remove every cached `<instance>/<uuid>/<key>` whose `uuid/key`
     * (lowercase) is not in `keep`, on every instance — a lookup falls back
     * across instances, so a pin keeps its folder on all of them — then the
     * `<uuid>` and `<instance>` folders left empty. Never follows a link: one
     * anywhere in the tree is removed as a link. A staging folder is removed
     * only once it is stale; `.`-names are left alone. Synchronous, so nothing
     * in this process can install or read in between. Answers how many entries went.
     */
    collectGarbage(keep: ReadonlySet<string>): { removed: number } {
      const root = cacheRoot()
      let removed = 0
      if (root === null || !isRealDir(root)) return { removed }
      const counted = (): void => {
        removed++
      }
      const now = Date.now()
      for (const instance of realChildren(root, counted, remove)) {
        const instanceDir = join(root, instance)
        for (const uuid of realChildren(instanceDir, counted, remove)) {
          const uuidDir = join(instanceDir, uuid)
          let entries: Dirent[]
          try {
            entries = readdirSync(uuidDir, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue
            const path = join(uuidDir, entry.name)
            if (!entry.isSymbolicLink()) {
              if (/\.(tmp|old)-/.test(entry.name)) {
                if (!staleStaging(path, now)) continue
              } else if (keep.has(`${uuid.toLowerCase()}/${entry.name.toLowerCase()}`)) {
                continue
              }
            }
            remove(path)
            removed++
          }
          removeIfEmpty(uuidDir, remove)
        }
        removeIfEmpty(instanceDir, remove)
      }
      if (removed > 0) logger.info(`unpinned ${kind.label} ${kind.keyNoun} removed`, { removed })
      return { removed }
    },

    /** Tests: put the cache under `root` (null: back to userData) and forget failures. */
    _reset(root: string | null = null): void {
      rootOverride = root
      failures.clear()
    }
  }
  return cache
}
