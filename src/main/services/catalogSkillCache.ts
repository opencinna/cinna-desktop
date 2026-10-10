/**
 * The shared cache of catalog skills a local agent pins (catalog U6):
 * `<userData>/catalog-skills/<instance>/<package_uuid>/<revision_number>/<name>/`.
 *
 * * **Shared across agents.** Two agents pinning one revision use one folder;
 *   nothing in it is an agent's.
 * * **Read-only.** Files 0444 (0555 when the archive marked them executable),
 *   folders 0555 — an engine or an assistant reading a skill cannot edit the
 *   copy every other agent uses.
 * * **Complete or absent.** A revision is unpacked into a staging folder
 *   beside it, with a marker naming what it holds
 *   (`.cinna-catalog-skill.json`: uuid, name, revision, `archive_sha256`),
 *   and renamed into place in one step. A revision folder without a marker
 *   that matches the pin is not a cached skill.
 * * **Per instance.** `<instance>` is a filesystem-safe key of the Cinna
 *   server ({@link instanceKey}). A lookup prefers the active profile's
 *   instance and then tries the others — a pin names a package uuid and the
 *   archive digest, not a server, and an agent folder is not tied to one
 *   profile — but only a marker whose digest equals the pin's counts.
 *
 * The last failed download of each pin (revision and digest) is kept in memory for the
 * Skills section's issue; a restart forgets it. Garbage collection of
 * revisions no agent pins any more is later work.
 *
 * Core: no Electron. Paths come from `runtimeHost`.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { getProfileScopeUserId } from '../auth/scope'
import { libraryService } from './libraryService'
import { createLogger } from '../logger/logger'
import { writeSkillTree, type SkillArchive } from '../kit/skillArchive'
import { isCatalogPinName, type CatalogSkillCacheState, type CatalogSkillRef } from '../kit/skills'

const logger = createLogger('catalog-skill-cache')

const CACHE_DIR = 'catalog-skills'
export const MARKER_FILE = '.cinna-catalog-skill.json'
/** A staging folder older than this belongs to no install still running. */
const STALE_STAGING_MS = 10 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_RE = /^[0-9a-f]{64}$/

/** What a revision folder's marker records. */
export interface CachedRevisionMarker {
  package_uuid: string
  package_id: string
  name: string
  revision_number: number
  archive_sha256: string
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

/** The pin's fields as safe path components, or null when one is not. */
export function cacheRefOf(ref: CatalogSkillRef): { uuid: string; revision: string; name: string; sha: string } | null {
  const uuid = typeof ref.packageUuid === 'string' ? ref.packageUuid.trim().toLowerCase() : ''
  const sha = typeof ref.archiveSha256 === 'string' ? ref.archiveSha256.trim().toLowerCase() : ''
  if (!UUID_RE.test(uuid) || !SHA256_RE.test(sha) || !isCatalogPinName(ref.name)) return null
  if (!Number.isInteger(ref.revisionNumber) || (ref.revisionNumber as number) < 1) return null
  return { uuid, revision: String(ref.revisionNumber), name: ref.name, sha }
}

let rootOverride: string | null = null
const failures = new Map<string, string>()

function cacheRoot(): string | null {
  if (rootOverride) return rootOverride
  try {
    return join(runtimeHost.getPath('userData'), CACHE_DIR)
  } catch {
    return null
  }
}

/**
 * A failure belongs to one pin's check, so the digest is part of the key: a
 * mismatch on one pin must never mark another pin of the same revision failed.
 */
function failureKey(safe: { uuid: string; revision: string; sha: string }): string {
  return `${safe.uuid}/${safe.revision}/${safe.sha}`
}

/** The active profile's instance key, or null without a Cinna profile. */
function activeInstance(): string | null {
  try {
    const host = libraryService.hostOf(getProfileScopeUserId())
    return host === null ? null : instanceKey(host)
  } catch {
    return null
  }
}

function readMarker(revisionDir: string): CachedRevisionMarker | null {
  try {
    const value = JSON.parse(readFileSync(join(revisionDir, MARKER_FILE), 'utf8')) as CachedRevisionMarker
    return value && typeof value === 'object' ? value : null
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

/** The skill folder in `revisionDir` when its marker matches the pin. */
function readyDir(revisionDir: string, ref: NonNullable<ReturnType<typeof cacheRefOf>>): string | null {
  // A linked `<uuid>` or revision folder is not a cached skill, whatever its marker says.
  const root = cacheRoot()
  const chain = root === null ? null : chainFrom(root, revisionDir)
  if (chain === null || !chain.every(isRealDir)) return null
  const marker = readMarker(revisionDir)
  if (!marker) return null
  if (typeof marker.archive_sha256 !== 'string' || marker.archive_sha256.toLowerCase() !== ref.sha) return null
  if (marker.name !== ref.name || String(marker.revision_number) !== ref.revision) return null
  if (typeof marker.package_uuid !== 'string' || marker.package_uuid.toLowerCase() !== ref.uuid) return null
  const dir = join(revisionDir, ref.name)
  try {
    const stat = lstatSync(dir)
    return stat.isDirectory() && !stat.isSymbolicLink() ? dir : null
  } catch {
    return null
  }
}

/**
 * Make a tree writable again and remove it. Never follows a link; best effort
 * (an undeletable leftover is swept on a later install).
 */
export function removeTree(path: string): void {
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
      logger.warn('could not remove a catalog skill folder', { path, error: String(err) })
    }
  }
}

function sweepStaging(parent: string, revision: string): void {
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith(`${revision}.tmp-`) && !name.startsWith(`${revision}.old-`)) continue
    const path = join(parent, name)
    try {
      if (now - statSync(path).mtimeMs < STALE_STAGING_MS) continue
    } catch {
      continue
    }
    removeTree(path)
  }
}

export const catalogSkillCache = {
  instanceKey,
  activeInstance,

  /** The cache's root folder (`<userData>/catalog-skills`), or null on a host without `userData`. */
  root(): string | null {
    return cacheRoot()
  },

  /** The revision folder a pin would be cached in on `instance`, or null for an unusable pin. */
  revisionDir(instance: string, ref: CatalogSkillRef): string | null {
    const root = cacheRoot()
    const safe = cacheRefOf(ref)
    if (root === null || safe === null) return null
    return join(root, instance, safe.uuid, safe.revision)
  },

  /**
   * Where a pinned revision stands on this computer: `ready` with its skill
   * folder, `failed` with the last download's sentence, or `missing`. What
   * `kit/skills.ts` is handed as its resolver. Never throws.
   */
  resolve(ref: CatalogSkillRef): CatalogSkillCacheState {
    const safe = cacheRefOf(ref)
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
      const dir = readyDir(join(root, instance, safe.uuid, safe.revision), safe)
      if (dir) return { state: 'ready', dir }
    }
    const failure = failures.get(failureKey(safe))
    return failure ? { state: 'failed', message: failure } : { state: 'missing' }
  },

  /** Whether `instance` already holds the pinned revision. */
  has(instance: string, ref: CatalogSkillRef): boolean {
    const safe = cacheRefOf(ref)
    const dir = catalogSkillCache.revisionDir(instance, ref)
    return safe !== null && dir !== null && readyDir(dir, safe) !== null
  },

  /**
   * Put a checked archive into the cache as the pinned revision, atomically:
   * staged beside its final place, marked, renamed in. A revision already
   * there with the pin's digest is kept. Answers the skill folder.
   *
   * @throws Error when the pin is unusable or the disk refuses; nothing is left at the final path then.
   */
  install(instance: string, ref: CatalogSkillRef & { packageId?: string }, archive: SkillArchive): string {
    const safe = cacheRefOf(ref)
    const finalDir = catalogSkillCache.revisionDir(instance, ref)
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
      if (!isRealDir(dir)) throw new Error('The catalog skill cache holds a link where a folder should be.')
    }
    sweepStaging(parent, safe.revision)
    const existing = readyDir(finalDir, safe)
    if (existing) return existing

    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    // Something at the final path that is not this revision (no marker, or
    // another digest) is moved aside first, so the rename below can land.
    // `lstat`, not `exists`: a link there (even a dangling one) is moved aside, never followed.
    if (lexists(finalDir)) {
      const aside = join(parent, `${safe.revision}.old-${stamp}`)
      renameSync(finalDir, aside)
      removeTree(aside)
    }
    const staging = join(parent, `${safe.revision}.tmp-${stamp}`)
    try {
      mkdirSync(staging)
      writeSkillTree(join(staging, safe.name), archive)
      const marker: CachedRevisionMarker = {
        package_uuid: safe.uuid,
        package_id: typeof ref.packageId === 'string' ? ref.packageId : '',
        name: safe.name,
        revision_number: Number(safe.revision),
        archive_sha256: safe.sha
      }
      writeFileSync(join(staging, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o444 })
      try {
        renameSync(staging, finalDir)
      } catch (err) {
        // Another install of the same revision landed first: theirs stands.
        const landed = readyDir(finalDir, safe)
        if (!landed) throw err
        removeTree(staging)
        return landed
      }
    } catch (err) {
      removeTree(staging)
      throw err
    }
    failures.delete(failureKey(safe))
    logger.info('catalog skill cached', { name: safe.name, revision: safe.revision })
    return join(finalDir, safe.name)
  },

  /** Remember why the last download of a revision failed, for the Skills section. */
  recordFailure(ref: CatalogSkillRef, message: string): void {
    const safe = cacheRefOf(ref)
    if (safe) failures.set(failureKey(safe), message)
  },

  clearFailure(ref: CatalogSkillRef): void {
    const safe = cacheRefOf(ref)
    if (safe) failures.delete(failureKey(safe))
  },

  /** Tests: put the cache under `root` (null: back to userData) and forget failures. */
  _reset(root: string | null = null): void {
    rootOverride = root
    failures.clear()
  }
}
