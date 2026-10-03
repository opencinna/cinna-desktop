/**
 * The real filesystem behind the `folder` task adapter. Node only, no
 * Electron: the contract suite runs it against a temp directory.
 *
 * Three rules from file handovers (`file_handovers_tech.md`), kept here:
 *
 * - **No symlink is followed.** Not at `.cinna`, not at `tasks`, not at a task
 *   file: a project-controlled link would let a folder point Cinna's writes at
 *   any file the user can write. A linked directory reads as absent; a linked
 *   file is skipped on a read and refused on a write (`ELOOP`).
 * - **Atomic publish.** A write lands in a temp file beside the target and is
 *   renamed over it, so an editor or an agent reading the file never sees half
 *   of it. A new file is published with `link`, which fails rather than
 *   replacing a file another writer created first.
 * - **Credentials are redacted** from what Cinna writes into a project folder,
 *   as for a delegation brief — a handoff note can quote a token.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FOLDER_BOARD_FILE, isFolderTaskFileName } from '../../../shared/folderTasks'
import { redactCredentialText } from '../../security/serviceCredentialRedaction'
import type { FolderEntry, FolderFs } from './folderTaskAdapter'

function refused(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path} is a symlink or not a regular file; it is not followed.`), { code: 'ELOOP' })
}

/** A real directory (not a link), false when absent or anything else. */
function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function makeDirectory(path: string): void {
  try {
    mkdirSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  if (!isRealDirectory(path)) throw refused(path)
}

function writeTemp(target: string, content: string): { temp: string; bytes: Buffer } {
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  const bytes = Buffer.from(redactCredentialText(content), 'utf8')
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try {
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
  return { temp, bytes }
}

export const folderTaskFs: FolderFs = {
  list(dir) {
    // Both levels, so `.cinna -> elsewhere` is refused as surely as `tasks -> elsewhere`.
    if (!isRealDirectory(dirname(dir)) || !isRealDirectory(dir)) return null
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
    const out: FolderEntry[] = []
    for (const entry of entries) {
      if (entry.name !== FOLDER_BOARD_FILE && !isFolderTaskFileName(entry.name)) continue
      try {
        const stat = lstatSync(join(dir, entry.name), { bigint: true })
        out.push({
          name: entry.name,
          stamp: `${stat.mtimeNs}:${stat.size}`,
          mtimeMs: Number(stat.mtimeMs),
          regular: stat.isFile() && !stat.isSymbolicLink()
        })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    return out
  },

  read(path) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return readFileSync(fd)
    } finally {
      closeSync(fd)
    }
  },

  replace(path, content) {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw refused(path)
    const { temp, bytes } = writeTemp(path, content)
    try {
      renameSync(temp, path)
    } catch (err) {
      try { unlinkSync(temp) } catch { /* already gone */ }
      throw err
    }
    return bytes
  },

  create(path, content) {
    const { temp, bytes } = writeTemp(path, content)
    try {
      linkSync(temp, path)
      return bytes
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw err
    } finally {
      unlinkSync(temp)
    }
  },

  ensureDir(dir) {
    makeDirectory(dirname(dir))
    makeDirectory(dir)
  },

  remove(path) {
    let stat
    try {
      stat = lstatSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw refused(path)
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
