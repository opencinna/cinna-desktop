/**
 * Pre-extraction check of a tar archive spooled to disk.
 *
 * Extraction itself is done by the system `tar` (GNU in the guest, bsdtar in
 * fake mode on macOS), which already refuses `..` and strips leading `/` by
 * default. That is not relied on: before any byte is extracted, this walks
 * every header (ustar, pax `x`, GNU `L`/`K` long names) and refuses
 *
 * - absolute names, `..` components, NUL, empty names;
 * - symlinks and hard links whose target is absolute or has any `..`
 *   component (lexically "inside" targets like `s/..` can still escape
 *   through another symlink, so `..` is refused outright);
 * - devices, FIFOs, sparse files, pax global headers that set a path, and
 *   anything else that is not a file, directory or link;
 * - a bad header checksum (so the system tar cannot read a different
 *   archive than the one checked).
 *
 * The extraction then goes into a staging directory, which is walked again
 * (`verifyTree`) before anything is moved into place.
 */
import { chmodSync, closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { VaultdError } from './util'

export interface TarSummary {
  files: number
  bytes: number
}

const BLOCK = 512

const refuse = (message: string): VaultdError => new VaultdError('invalid', `Archive refused: ${message}`)

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8')
}

function octal(buf: Buffer, start: number, length: number): number {
  const field = buf.subarray(start, start + length)
  if (field[0] & 0x80) {
    // GNU base-256: big-endian, first byte's high bit is the marker.
    let value = field[0] & 0x7f
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]
    return value
  }
  const text = cString(buf, start, length).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw refuse('bad numeric field')
  return parseInt(text, 8)
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
  return sum === stored
}

/** Throws unless `name` is a relative path without `..`. Returns it without a leading `./`. */
export function safeMemberName(name: string): string {
  if (name.includes('\0')) throw refuse('NUL in a name')
  if (name.startsWith('/')) throw refuse(`absolute path ${JSON.stringify(name)}`)
  const parts = name.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) throw refuse(`parent reference in ${JSON.stringify(name)}`)
  return parts.join('/')
}

export function safeLinkTarget(target: string, member: string): void {
  if (target === '' || target.includes('\0') || target.startsWith('/')) {
    throw refuse(`link ${JSON.stringify(member)} points outside the folder`)
  }
  if (target.split('/').some((p) => p === '..')) {
    throw refuse(`link ${JSON.stringify(member)} points outside the folder`)
  }
}

function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  let pos = 0
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos)
    if (space === -1) break
    const len = parseInt(data.subarray(pos, space).toString('ascii'), 10)
    if (!Number.isFinite(len) || len <= 0 || pos + len > data.length) throw refuse('bad pax header')
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1))
    pos += len
  }
  return out
}

/** Walk every header of the plain (uncompressed) tar at `file`. */
export function checkTar(file: string): TarSummary {
  const fd = openSync(file, 'r')
  try {
    const header = Buffer.alloc(BLOCK)
    let offset = 0
    let files = 0
    let bytes = 0
    let longName: string | null = null
    let longLink: string | null = null
    let pax: Map<string, string> | null = null
    const readAt = (buf: Buffer, at: number): number => readSync(fd, buf, 0, buf.length, at)
    const readData = (size: number): Buffer => {
      if (size > 1024 * 1024) throw refuse('oversized extension header')
      const data = Buffer.alloc(size)
      if (readAt(data, offset + BLOCK) !== size) throw refuse('truncated archive')
      return data
    }
    for (;;) {
      const n = readAt(header, offset)
      if (n === 0) break
      if (n !== BLOCK) throw refuse('truncated archive')
      if (header.every((b) => b === 0)) break
      if (!checksumOk(header)) throw refuse('bad header checksum')
      const type = String.fromCharCode(header[156] || 0x30)
      let size = octal(header, 124, 12)
      const advance = (): void => { offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK }

      if (type === 'L' || type === 'K') {
        const value = cString(readData(size), 0, size)
        if (type === 'L') longName = value
        else longLink = value
        advance()
        continue
      }
      if (type === 'x' || type === 'g') {
        const records = parsePax(readData(size))
        if (type === 'g') {
          if (records.has('path') || records.has('linkpath')) throw refuse('global path header')
        } else {
          pax = records
        }
        advance()
        continue
      }

      const prefix = header[257] === 0x75 /* 'u' of ustar */ ? cString(header, 345, 155) : ''
      const baseName = cString(header, 0, 100)
      const name = pax?.get('path') ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName)
      const linkName = pax?.get('linkpath') ?? longLink ?? cString(header, 157, 100)
      const paxSize = pax?.get('size')
      if (paxSize !== undefined) {
        if (!/^\d+$/.test(paxSize)) throw refuse('bad pax size')
        size = Number(paxSize)
      }
      longName = null
      longLink = null
      pax = null

      const member = safeMemberName(name)
      switch (type) {
        case '0':
        case '7':
          if (member === '') throw refuse('file without a name')
          files++
          bytes += size
          break
        case '5':
          break
        case '2':
          if (member === '') throw refuse('link without a name')
          safeLinkTarget(linkName, member)
          break
        case '1':
          if (member === '') throw refuse('link without a name')
          safeLinkTarget(linkName, member)
          safeMemberName(linkName)
          size = 0
          break
        default:
          throw refuse(`unsupported entry type ${JSON.stringify(type)} for ${JSON.stringify(member)}`)
      }
      advance()
    }
    if (longName !== null || longLink !== null || pax !== null) throw refuse('dangling extension header')
    return { files, bytes }
  } finally {
    closeSync(fd)
  }
}

/**
 * After extraction into `root`: no symlink may point outside (absolute or
 * `..`), and nothing but files, directories and links may exist.
 */
export function verifyTree(root: string): void {
  const walk = (dir: string, rel: string): void => {
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const member = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        safeLinkTarget(readlinkSync(path), member)
      } else if (entry.isDirectory()) {
        walk(path, member)
      } else if (entry.isFile()) {
        // No setuid/setgid/sticky bits from an archive, whichever tar extracted it.
        const mode = lstatSync(path).mode
        if (mode & 0o7000) chmodSync(path, mode & 0o777)
      } else {
        throw refuse(`unsupported entry ${JSON.stringify(member)}`)
      }
    }
  }
  if (!lstatSync(root).isDirectory()) throw refuse('extraction failed')
  walk(root, '')
}
