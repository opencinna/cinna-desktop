/**
 * A plugin server's writable working copy of its cached tree (`ManagedSpec.work`,
 * `<userData>/plugin-work/<entry>/<sha>/<server>`, one per server so two
 * servers of one snapshot never share what they write), for a uv project
 * with no `uv.lock` and a `uvx --from <folder>` (`stdioRuntimes.ts`).
 *
 * * **Checked in the connect.** The manager prepares it ({@link prepareWorkCopy})
 *   after the provider's old process has stopped, never while its config is
 *   built: a copy is checked and copied again only when nothing runs from it.
 * * **Checked cheaply.** Each copied file's size and mtime are recorded with
 *   its digest; a file whose size and mtime still match is not hashed again.
 * * **Never pulled from under a server.** A copy a connected server runs
 *   from is in use ({@link isWorkInUse}): it is not deleted (`managed.ts`
 *   discard and sweep), and when its tree changed another launch from it is
 *   refused with the config's sentence rather than copying again under the
 *   running server.
 *
 * Kept apart from `managed.ts` so the manager imports only this (fs, no services).
 * Core: no Electron.
 */

import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/** What the manager needs to prepare a launch's working copy, carried by its config (data only). */
export interface WorkCopySpec {
  /** The verified cached tree the copy is made from. */
  root: string
  /** The working copy. */
  work: string
  /** The sentence a launch is refused with when the copy changed while another connection runs from it. */
  changedReason: string
  /** The sentence a launch is refused with when the copy cannot be made. */
  failedReason: string
}

/** Every folder and file under `dir` writable by its owner (the cache's copy is read-only). */
function makeWritable(dir: string): void {
  chmodSync(dir, 0o755)
  const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) makeWritable(path)
    else if (entry.isFile()) chmodSync(path, statSync(path).mode | 0o200)
  }
}

/** What a server may write into its working copy, never checked: its lock, its environments, caches and build output. */
function writtenByServer(rel: string): boolean {
  const parts = rel.split(/[\\/]/)
  const name = parts[parts.length - 1]
  if (name === 'uv.lock') return true
  return parts.some((part, at) =>
    part === '.venv' || part === '__pycache__' || part.endsWith('.egg-info') || (at < parts.length - 1 && (part === 'build' || part === 'dist'))
  )
}

const sha256Of = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Every regular file under `dir` the copy is checked by, relative path → sha256 (what the server writes left out). */
function treeDigests(dir: string, rel = '', out: Record<string, string> = {}): Record<string, string> {
  const entries: Dirent[] = readdirSync(join(dir, rel), { withFileTypes: true })
  for (const entry of entries) {
    const path = rel ? `${rel}/${entry.name}` : entry.name
    if (writtenByServer(path)) continue
    if (entry.isDirectory()) treeDigests(dir, path, out)
    else if (entry.isFile()) out[path] = sha256Of(join(dir, path))
  }
  return out
}

/** One copied file as recorded at copy: its digest (from the cache), and the copy's size and mtime. */
interface WorkFile {
  sha256: string
  size: number
  mtimeMs: number
}

/** The working copy's marker (`<work>.source`): the tree it was copied from and each copied file. An older marker holds bare digests. */
interface WorkMarker {
  root: string
  files: Record<string, WorkFile | string>
}

function readWorkMarker(work: string): WorkMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(`${work}.source`, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const { root, files } = parsed as { root?: unknown; files?: unknown }
    if (typeof root !== 'string' || !files || typeof files !== 'object' || Array.isArray(files)) return null
    return { root, files: files as Record<string, WorkFile | string> }
  } catch {
    return null
  }
}

/** Whether `work` still holds every file of its copy as it was copied (new files, and what the server writes, are its own). */
function workCopyIntact(work: string, marker: WorkMarker): boolean {
  try {
    if (!statSync(work).isDirectory()) return false
    for (const [rel, recorded] of Object.entries(marker.files)) {
      const path = join(work, rel)
      const stat = lstatSync(path)
      if (!stat.isFile()) return false
      const known = typeof recorded === 'object' && recorded !== null ? recorded : null
      // Same size and mtime as at copy: not read again.
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue
      const digest = known ? known.sha256 : recorded
      if (typeof digest !== 'string' || sha256Of(path) !== digest) return false
    }
    return true
  } catch {
    return false
  }
}

/** Whether `work` is a copy of `root` whose copied files are unchanged. */
export function workCopyCurrent(root: string, work: string): boolean {
  const marker = readWorkMarker(work)
  return !!marker && marker.root === root && workCopyIntact(work, marker)
}

/**
 * Make `work` a writable copy of the cached tree `root`, unless it already
 * is one ({@link workCopyCurrent}). A copy that changed is copied again from
 * the cache — the verified cache is the source of truth, so a mismatch is
 * repaired, never refused. What the server writes there (its `uv.lock`,
 * `.venv`, `__pycache__`, `*.egg-info`, `build/`, `dist/`, any new file) is
 * never checked, and stays for the next launch. Copied whole into a sibling
 * first and renamed into place, so a half copy is never used. The caller
 * makes sure no server runs from it ({@link prepareWorkCopy}).
 */
export function ensurePluginWorkCopy(root: string, work: string): void {
  if (workCopyCurrent(root, work)) return
  mkdirSync(dirname(work), { recursive: true })
  const staging = `${work}.staging-${process.pid}-${Date.now()}`
  try {
    const digests = treeDigests(root)
    cpSync(root, staging, { recursive: true, verbatimSymlinks: true })
    makeWritable(staging)
    const files: Record<string, WorkFile> = {}
    for (const [rel, sha256] of Object.entries(digests)) {
      const stat = lstatSync(join(staging, rel))
      files[rel] = { sha256, size: stat.size, mtimeMs: stat.mtimeMs }
    }
    rmSync(`${work}.source`, { force: true })
    rmSync(work, { recursive: true, force: true })
    renameSync(staging, work)
    writeFileSync(`${work}.source`, JSON.stringify({ root, files } satisfies WorkMarker))
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    throw err
  }
}

/** work copy → the providers whose connection runs from it. */
const inUse = new Map<string, Set<string>>()

/** Whether a connection other than `except` runs from `path` or from a copy under it. */
export function isWorkInUse(path: string, except?: string): boolean {
  for (const [work, ids] of inUse) {
    if (work !== path && !work.startsWith(`${path}${sep}`)) continue
    for (const id of ids) if (id !== except) return true
  }
  return false
}

/** The provider no longer runs from any copy (its connection stopped). */
export function releaseWorkCopies(providerId: string): void {
  for (const [work, ids] of inUse) {
    ids.delete(providerId)
    if (ids.size === 0) inUse.delete(work)
  }
}

/**
 * Before `providerId` launches from `spec.work` (its own old process already
 * stopped): an unchanged copy is used as it is; a missing or changed one is
 * copied again from the cache — unless another connection runs from it,
 * when the launch is refused with `spec.changedReason`. A copy that cannot
 * be made refuses it with `spec.failedReason`. Answers the refusal, or null
 * with the copy marked in use until {@link releaseWorkCopies}.
 */
export function prepareWorkCopy(providerId: string, spec: WorkCopySpec): string | null {
  releaseWorkCopies(providerId)
  if (!workCopyCurrent(spec.root, spec.work)) {
    if (isWorkInUse(spec.work, providerId)) return spec.changedReason
    try {
      // A copy of the whole snapshot from before copies were per server (`<snapshot>.source` beside it) goes first.
      const snapshot = dirname(spec.work)
      if (existsSync(`${snapshot}.source`) && !isWorkInUse(snapshot, providerId)) {
        rmSync(`${snapshot}.source`, { force: true })
        rmSync(snapshot, { recursive: true, force: true })
      }
      ensurePluginWorkCopy(spec.root, spec.work)
    } catch {
      return spec.failedReason
    }
  }
  const ids = inUse.get(spec.work) ?? new Set<string>()
  ids.add(providerId)
  inUse.set(spec.work, ids)
  return null
}

/** Tests: forget every copy in use. */
export function _resetWorkCopiesInUse(): void {
  inUse.clear()
}
