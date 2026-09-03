/**
 * Reading and writing `cinna-agent.json`.
 *
 * Three parties write these files — this desktop, a coding assistant working in
 * the folder, and cinna-core at import time — so two rules hold everywhere:
 *
 * 1. **Unknown keys survive.** A manifest is parsed into a plain object and
 *    written back from that same object, so a key this build has never heard of
 *    comes out byte-identical (2-space JSON, trailing newline, key order kept).
 * 2. **Never write over a file that changed underneath.** `readWithStamp`
 *    returns a stamp whose authority is a SHA-256 of the bytes it read;
 *    `writeIfUnchanged` refuses with a typed `KitError('manifest_modified')`
 *    when the file no longer matches it. The page turns that into a reload
 *    prompt rather than clobbering an edit.
 *
 *    The stamp is content-derived on purpose. mtime and size are *not* enough:
 *    `cp -p`, `rsync -t`, `git checkout` and several editors rewrite a file to
 *    the same size with its timestamps preserved, and a metadata stamp misses
 *    exactly that — silently losing an assistant's edit in the case the guard
 *    exists for. mtime+size survive only as a cheap pre-check: when they differ
 *    the file certainly changed, so the hash is not read at all.
 *
 * Writes are atomic: a temp file in the same directory, fsynced, then renamed,
 * so a reader never sees half a manifest.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { KitError } from '../errors'
import { sha256Hex } from './hash'
import { createLogger } from '../logger/logger'
import { MANIFEST_FILE, type CinnaAgentManifest } from '../../shared/kit/manifest'

const logger = createLogger('kit-manifest')

/**
 * "Are these still the bytes I read" fingerprint. Compared, never interpreted.
 * `hash` is the authority; `mtimeMs` and `size` only short-circuit it.
 */
export interface ManifestStamp {
  mtimeMs: number
  size: number
  /** SHA-256 of the exact bytes the stamp was taken from. */
  hash: string
}

export interface ManifestWithStamp {
  manifest: CinnaAgentManifest
  stamp: ManifestStamp
}

/** Prefix every temp file of an in-flight manifest write shares. */
const TEMP_PREFIX = `.${MANIFEST_FILE}.`
const TEMP_SUFFIX = '.tmp'
/** A temp file older than this cannot belong to a write still in flight. */
const STALE_TEMP_MS = 60_000

/**
 * Remove temp files left behind by a write that was killed between `open` and
 * `rename` — a crash or a SIGKILL, which no catch block can clean up after. The
 * contract's exclude list also drops `***.tmp` so an orphan can never reach a
 * Cinna instance, but an orphan sitting in the folder still confuses anyone
 * reading it, so it is swept the next time the manifest is written.
 *
 * Anything younger than {@link STALE_TEMP_MS} is left alone: it may belong to
 * another process writing the same folder right now.
 */
function sweepStaleTemps(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue
    const abs = join(dir, name)
    try {
      if (now - statSync(abs).mtimeMs < STALE_TEMP_MS) continue
      unlinkSync(abs)
      logger.warn('removed an orphaned manifest temp file', { path: abs })
    } catch {
      /* another process may have swept it first; nothing to do either way */
    }
  }
}

/** Path of the manifest inside an agent folder. */
export function manifestPath(agentDir: string): string {
  return join(agentDir, MANIFEST_FILE)
}

/** Current stamp of a file, or `null` when it cannot be read. */
export function readStamp(path: string): ManifestStamp | null {
  try {
    const stat = statSync(path)
    return { mtimeMs: stat.mtimeMs, size: stat.size, hash: sha256Hex(readFileSync(path)) }
  } catch {
    return null
  }
}

/**
 * Whether a file still holds the bytes a stamp was taken from.
 *
 * Exported because every "refuse to save over a changed file" guard in the app
 * needs the same answer, and needs it decided the same way: metadata first
 * because it is free, the content hash always, because `cp -p`, `rsync -t`,
 * `git checkout` and several editors rewrite a file to the same size with its
 * timestamps preserved. A comparison that stops at mtime and size returns
 * "unchanged" for exactly those writers and silently loses their work.
 */
export function stampsMatch(current: ManifestStamp | null, expected: ManifestStamp): boolean {
  if (current === null) return false
  // Different metadata already proves a change; no need to read the file.
  if (current.mtimeMs !== expected.mtimeMs || current.size !== expected.size) return false
  return current.hash === expected.hash
}

/**
 * Parse manifest text. Throws `KitError` with `manifest_invalid_json` or
 * `manifest_not_object` — callers that must not throw (the validator, the
 * scanner) catch it and report the code.
 */
export function parseManifest(text: string, path = MANIFEST_FILE): CinnaAgentManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new KitError(
      'manifest_invalid_json',
      `${MANIFEST_FILE} is not valid JSON.`,
      `${path}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KitError('manifest_not_object', `${MANIFEST_FILE} must contain a JSON object.`, path)
  }
  return parsed as CinnaAgentManifest
}

/** Read and parse a manifest together with the stamp a later write compares. */
export function readWithStamp(path: string): ManifestWithStamp {
  let text: string
  let stamp: ManifestStamp | null
  // A read is also the moment to clear orphans: `writeAtomically` can only
  // unlink a temp file on a *caught* failure, so a crash, a kill or a power loss
  // leaves one behind forever, and every reader of the folder then sees it.
  sweepStaleTemps(dirname(path))
  try {
    text = readFileSync(path, 'utf8')
    const stat = statSync(path)
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size, hash: sha256Hex(text) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      throw new KitError('manifest_not_found', `No ${MANIFEST_FILE} in this folder.`, path)
    }
    logger.error('failed to read manifest', { path, error: err })
    throw new KitError(
      'manifest_unreadable',
      `Could not read ${MANIFEST_FILE}.`,
      `${path}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!stamp) {
    throw new KitError('manifest_unreadable', `Could not stat ${MANIFEST_FILE}.`, path)
  }
  return { manifest: parseManifest(text, path), stamp }
}

/** Read and parse a manifest, discarding the stamp. */
export function readManifest(path: string): CinnaAgentManifest {
  return readWithStamp(path).manifest
}

/** Serialize a manifest the way every writer of these files does. */
export function serializeManifest(manifest: CinnaAgentManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function writeAtomically(path: string, contents: string): void {
  sweepStaleTemps(dirname(path))
  const temp = join(dirname(path), `${TEMP_PREFIX}${process.pid}.${Date.now()}${TEMP_SUFFIX}`)
  let fd: number | null = null
  try {
    fd = openSync(temp, 'w')
    writeSync(fd, contents)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, path)
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* the write already failed; the close error adds nothing */
      }
    }
    try {
      unlinkSync(temp)
    } catch {
      /* the temp file may never have been created */
    }
    logger.error('failed to write manifest', { path, error: err })
    throw new KitError(
      'write_failed',
      `Could not write ${MANIFEST_FILE}.`,
      `${path}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Write a manifest atomically, unconditionally. Returns the new stamp. */
export function writeManifest(path: string, manifest: CinnaAgentManifest): ManifestStamp {
  writeAtomically(path, serializeManifest(manifest))
  const stamp = readStamp(path)
  if (!stamp) {
    throw new KitError('write_failed', `Could not stat ${MANIFEST_FILE} after writing.`, path)
  }
  logger.debug('manifest written', { path, size: stamp.size })
  return stamp
}

/**
 * Write a manifest only if the file on disk still matches `stamp` — the guard
 * against the assistant, the agent and the desktop writing the same folder.
 *
 * @throws KitError `manifest_modified` when the file changed underneath.
 */
export function writeIfUnchanged(
  path: string,
  manifest: CinnaAgentManifest,
  stamp: ManifestStamp
): ManifestStamp {
  const current = readStamp(path)
  if (!current) {
    throw new KitError(
      'manifest_modified',
      `${MANIFEST_FILE} was removed or renamed while it was open.`,
      path
    )
  }
  if (!stampsMatch(current, stamp)) {
    logger.warn('refusing to overwrite a manifest that changed underneath', { path })
    throw new KitError(
      'manifest_modified',
      `${MANIFEST_FILE} changed on disk since it was read. Reload before saving.`,
      path
    )
  }
  return writeManifest(path, manifest)
}
