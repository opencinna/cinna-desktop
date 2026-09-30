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

/** The formats the desktop read off the clipboard, as raw as it found them. */
export interface ClipboardFileSources {
  /** macOS `public.file-url`: one `file://` URL, the first file copied. */
  fileUrl?: string
  /** macOS `NSFilenamesPboardType`: an XML plist array of every path copied. */
  filenamesPlist?: string
  /** Linux `text/uri-list`: `file://` URLs, one per line, `#` comments. */
  uriList?: string
  /** Windows `FileNameW`: a UTF-16LE path, NUL-terminated. */
  fileNameW?: Buffer
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

function decodeXmlEntities(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (whole, name: string, dec?: string, hex?: string) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    switch (name.toLowerCase()) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'amp':
        return '&'
      default:
        return whole
    }
  })
}

/** The absolute paths in an `NSFilenamesPboardType` plist, in order. */
export function parseFilenamesPlist(plist: string): string[] {
  const out: string[] = []
  for (const match of plist.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    const path = decodeXmlEntities(match[1]).trim()
    if (path.startsWith('/')) out.push(path)
  }
  return out
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
 * Every path the clipboard references, first to last, without duplicates. The
 * plist lists all of a multi-file copy; `public.file-url` names only the first,
 * so it is the fallback.
 */
export function clipboardFilePaths(sources: ClipboardFileSources): string[] {
  const paths: string[] = []
  if (sources.filenamesPlist) paths.push(...parseFilenamesPlist(sources.filenamesPlist))
  if (paths.length === 0 && sources.fileUrl) {
    const single = fileUrlToPath(sources.fileUrl)
    if (single) paths.push(single)
  }
  if (paths.length === 0 && sources.uriList) paths.push(...parseUriList(sources.uriList))
  if (paths.length === 0 && sources.fileNameW && sources.fileNameW.length > 0) {
    const name = sources.fileNameW.toString('utf16le').replace(/\0[\s\S]*$/, '').trim()
    if (name) paths.push(name)
  }
  return [...new Set(paths)]
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
  sources: ClipboardFileSources
  /** The clipboard's image as PNG bytes; null or empty when it holds none. */
  readImagePng: () => Buffer | null
  dir: string
  now: Date
}): Promise<string[]> {
  const refs = clipboardFilePaths(input.sources)
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
  const png = input.readImagePng()
  if (!png || png.length === 0) return []
  const path = await writePastedImage(input.dir, png, input.now)
  logger.info('pasted image saved', { bytes: png.length })
  return [path]
}

/** Remove every pasted image. Called at start, not awaited; a failure costs only disk space. */
export async function clearPastedFiles(userData: string): Promise<void> {
  await rm(pastedRoot(userData), { recursive: true, force: true })
}
