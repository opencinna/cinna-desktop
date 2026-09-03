/**
 * The cloud-import view of an agent folder: which files travel, and one hash
 * over them.
 *
 * The hash is what makes drift visible — a publication records the hash of the
 * tree it pushed, and a later scan compares it against the current one to say
 * "N local changes not published". So it must depend on *content only*: it is a
 * SHA-256 over `<relative path>\0<sha256 of the bytes>\n` lines, sorted by path.
 * No mtimes, no inode data, no directory order, nothing machine-specific — two
 * machines with the same files produce the same hash.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { sha256Hex } from './hash'
import { join } from 'node:path'
import { KitError } from '../errors'
import { createLogger } from '../logger/logger'
import type { LayoutView } from './layout'

const logger = createLogger('kit-export')

export interface ExportTree {
  /** Agent-relative POSIX paths that travel, sorted. */
  files: string[]
  /** Stable content hash over those files, `sha256:<hex>`. */
  contentHash: string
  /** Sum of the file sizes, for "this is how much you are about to upload". */
  totalBytes: number
  /**
   * Files that are in the tree but could not be read — a transient `EACCES`, a
   * file removed mid-walk, a broken mount.
   *
   * **A publish must refuse while this is non-empty.** Each one is folded into
   * the hash as a fixed marker, so the digest is stable and comparable, but it
   * no longer describes the bytes that would be uploaded: recorded on a
   * publication it would read as "up to date" forever, and on a scan it looks
   * like drift that never resolves.
   */
  unreadable: string[]
}

/**
 * Walk an agent folder and return the agent-relative paths that survive the
 * contract's `cloud_import_excludes`, sorted.
 *
 * Symlinks are never followed and never listed: a folder that travels must not
 * be able to reach outside itself.
 */
export function collectExportFiles(agentDir: string, layout: LayoutView): string[] {
  const files: string[] = []

  const walk = (relDir: string): void => {
    const absDir = relDir === '' ? agentDir : join(agentDir, relDir)
    let entries: Dirent[]
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch (err) {
      logger.warn('skipping unreadable directory during export walk', { relDir, error: err })
      return
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (layout.isExcludedFromExport(rel)) continue
      if (entry.isDirectory()) {
        walk(rel)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }

  walk('')
  return files.sort()
}

/** Marker folded in for a file whose bytes could not be read. */
const UNREADABLE_MARKER = '\0unreadable'

export interface ExportHash {
  contentHash: string
  /** Paths whose bytes could not be read; see {@link ExportTree.unreadable}. */
  unreadable: string[]
}

/**
 * Hash a file list. A file that cannot be read does not abort the walk — a race
 * with a running agent must not fail a scan — but it is reported, because a hash
 * that silently stands in for missing content is worse than no hash: it is a
 * plausible digest of a tree that does not exist.
 */
export function hashExportFiles(agentDir: string, files: string[]): ExportHash {
  const digest = createHash('sha256')
  const unreadable: string[] = []
  for (const rel of [...files].sort()) {
    let entryHash: string
    try {
      entryHash = sha256Hex(readFileSync(join(agentDir, rel)))
    } catch (err) {
      logger.warn('file in the export tree could not be read', { rel, error: err })
      unreadable.push(rel)
      entryHash = UNREADABLE_MARKER
    }
    digest.update(`${rel}\0${entryHash}\n`)
  }
  return { contentHash: `sha256:${digest.digest('hex')}`, unreadable }
}

/**
 * Build the export view of an agent folder: the file list, the content hash and
 * the total size.
 *
 * @throws KitError `export_failed` when the folder itself cannot be read.
 */
export function buildExportTree(agentDir: string, layout: LayoutView): ExportTree {
  try {
    statSync(agentDir)
  } catch (err) {
    throw new KitError(
      'export_failed',
      'This agent folder could not be read.',
      `${agentDir}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const files = collectExportFiles(agentDir, layout)
  let totalBytes = 0
  for (const rel of files) {
    try {
      totalBytes += statSync(join(agentDir, rel)).size
    } catch {
      /* counted as zero; hashExportFiles logs the same file */
    }
  }
  const { contentHash, unreadable } = hashExportFiles(agentDir, files)
  if (unreadable.length > 0) {
    logger.warn('export tree has unreadable files; its hash does not describe the tree', {
      agentDir,
      unreadable
    })
  }
  logger.debug('export tree built', { agentDir, fileCount: files.length, totalBytes })
  return { files, contentHash, totalBytes, unreadable }
}
