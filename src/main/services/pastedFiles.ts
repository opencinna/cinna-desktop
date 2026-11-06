import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('pasted-files')

/**
 * Files a paste into the composer attaches. The clipboard itself is the
 * desktop's (`host/desktop/clipboard.ts` reads it); this module turns what it
 * read into paths on disk, without Electron.
 *
 * File references win over an image: a Finder copy also carries the file's
 * icon as an image, and the user copied the file, not its icon. An image with
 * no references (a screenshot, an image copied in a browser) is written as a
 * PNG under `<userData>/tmp/pasted/`, cleared at each start.
 */

/** The folder, under `userData`, that holds pasted images until the next start. */
export const PASTED_DIR = join('tmp', 'pasted')

/** The drop's refusal, so a pasted folder reads the same as a dropped one. */
export const NOT_A_FILE_ERROR = 'Folders and unresolved files cannot be attached'

export function pastedRoot(userData: string): string {
  return join(userData, PASTED_DIR)
}

/** A `file://` URL as a local path; null for anything else or a malformed URL. */
export function fileUrlToPath(url: string): string | null {
  const trimmed = url.trim()
  if (!/^file:\/\//i.test(trimmed)) return null
  try {
    return fileURLToPath(trimmed)
  } catch {
    return null
  }
}

/** The local paths in a `text/uri-list`; comments and non-file URLs are skipped. */
export function parseUriList(list: string): string[] {
  return list
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map(fileUrlToPath)
    .filter((path): path is string => path !== null)
}

/**
 * Every path the clipboard references, first to last, without duplicates.
 * Electron (44+) maps the platform's native file references to one
 * `text/uri-list` — every file of a multi-file Finder copy on macOS (probed on
 * Electron 45), the list itself on Linux, CF_HDROP on Windows (per Electron's
 * docs; unprobed).
 */
export function clipboardFilePaths(uriList: string | undefined): string[] {
  return uriList ? [...new Set(parseUriList(uriList))] : []
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `Pasted image 2026-09-30 at 14.05.33.png`, in local time — the macOS screenshot style. */
export function pastedImageName(date: Date, attempt = 1): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  return `Pasted image ${day} at ${time}${attempt > 1 ? ` (${attempt})` : ''}.png`
}

/** Write a pasted PNG under `dir`, never over an earlier paste of the same second. */
export async function writePastedImage(dir: string, png: Buffer, now: Date): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (let attempt = 1; ; attempt += 1) {
    const path = join(dir, pastedImageName(now, attempt))
    try {
      await writeFile(path, png, { flag: 'wx', mode: 0o600 })
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 1000) continue
      throw new FileError('write_failed', `Could not save the pasted image: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * The paths a paste attaches: the regular files the clipboard references, or
 * else its image written to `dir`, or else none. References that are all
 * folders or gone are refused with the drop's sentence; a mix keeps the files.
 */
export async function resolvePastedFiles(input: {
  /** The clipboard's `text/uri-list`, as read; undefined when it holds none. */
  uriList: string | undefined
  /** The clipboard's image as PNG bytes; null or empty when it holds none. */
  readImagePng: () => Promise<Buffer | null>
  dir: string
  now: Date
}): Promise<string[]> {
  const refs = clipboardFilePaths(input.uriList)
  if (refs.length > 0) {
    const files: string[] = []
    for (const path of refs) {
      const isFile = await stat(path).then((s) => s.isFile(), () => false)
      if (isFile) files.push(path)
    }
    logger.info('pasted file references', { refs: refs.length, files: files.length })
    if (files.length === 0) throw new FileError('not_a_file', NOT_A_FILE_ERROR)
    return files
  }
  const png = await input.readImagePng()
  if (!png || png.length === 0) return []
  const path = await writePastedImage(input.dir, png, input.now)
  logger.info('pasted image saved', { bytes: png.length })
  return [path]
}

/** Remove every pasted image. Called at start, not awaited; a failure costs only disk space. */
export async function clearPastedFiles(userData: string): Promise<void> {
  await rm(pastedRoot(userData), { recursive: true, force: true })
}
