/**
 * Reading a catalog skill archive — the `tar.gz` cinna-core serves from
 * `GET /api/v1/skills/packages/{uuid}/revisions/{n}/download` — safely, with
 * no dependency beyond `node:zlib`.
 *
 * Core builds it in `SkillCatalogService._build_archive_bytes` with Python's
 * `tarfile` (PAX format by default): regular files only, sorted, under
 * `skills/<name>/`, mode 0755 or 0644, gzip mtime 0. The reader accepts that
 * and the other shape core names for a skill folder (one top-level `<name>/`,
 * as an upload carries it), and nothing looser:
 *
 * * ustar headers, pax extended headers (`x` per entry, `g` global — read and
 *   ignored) and GNU long names (`L`). Long link names (`K`) are read and
 *   dropped, since no link is ever accepted.
 * * Regular files and directories only. Symlinks, hard links, devices, FIFOs
 *   and anything else refuse the whole archive.
 * * No absolute path, no `..` or `.` segment, no backslash, no NUL, no two
 *   entries for one path (case-insensitively, as macOS's default disk sees
 *   them), no file where a folder is needed.
 * * Every entry under exactly one root, `skills/<name>/` or `<name>/`, with
 *   `<name>` the pin's, and a `SKILL.md` at the top of it.
 * * Gunzip is capped ({@link MAX_UNPACKED_BYTES}) so a small download cannot
 *   expand into a disk-filling bomb; the entry count is capped too.
 *
 * {@link readSkillArchive} parses without touching the disk;
 * {@link writeSkillTree} lays the result out under a folder with read-only
 * modes. Neither is told where the cache is.
 *
 * Core: `node:` builtins only.
 */

import { gunzipSync } from 'node:zlib'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Largest archive accepted from the network — core's own publish limit. */
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
/** Largest the archive may unpack to. */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024
/** Most entries an archive may hold. */
export const MAX_ENTRIES = 10_000

const BLOCK = 512

/** Why an archive was refused: a short, plain sentence. */
export class SkillArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillArchiveError'
  }
}

export interface SkillArchiveFile {
  /** POSIX path relative to the skill folder, e.g. `SKILL.md`, `scripts/run.sh`. */
  path: string
  data: Buffer
  /** The archive gave it any execute bit. */
  executable: boolean
}

export interface SkillArchive {
  /** Relative POSIX paths of the folders inside the skill folder (not the root itself). */
  dirs: string[]
  files: SkillArchiveFile[]
}

interface RawEntry {
  path: string
  type: 'file' | 'dir'
  mode: number
  data: Buffer
}

function cString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8')
}

/** An octal numeric field, or GNU's base-256 form (high bit of the first byte set). */
function numeric(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length)
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f
    for (let index = 1; index < field.length; index++) {
      value = value * 256 + field[index]
      if (!Number.isSafeInteger(value)) throw new SkillArchiveError('The skill archive has an entry that is too large.')
    }
    return value
  }
  const text = cString(block, start, length).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new SkillArchiveError('The skill archive has a damaged header.')
  return parseInt(text, 8)
}

function checksumOk(block: Buffer): boolean {
  const stored = numeric(block, 148, 8)
  let sum = 0
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index]
  return sum === stored
}

/** pax records: `<len> <key>=<value>\n`, repeated. */
function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number(data.subarray(offset, space).toString('ascii'))
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      throw new SkillArchiveError('The skill archive has a damaged extended header.')
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return out
}

/** The tar stream's entries, raw: every member type checked, nothing written. */
function readTar(tar: Buffer): RawEntry[] {
  const entries: RawEntry[] = []
  let offset = 0
  let paxPath: string | null = null
  let paxSize: number | null = null
  let longName: string | null = null

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    if (!checksumOk(header)) throw new SkillArchiveError('The skill archive has a damaged header.')
    const typeflag = String.fromCharCode(header[156])
    let size = numeric(header, 124, 12)
    if (paxSize !== null && typeflag !== 'x' && typeflag !== 'g' && typeflag !== 'L' && typeflag !== 'K') size = paxSize
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new SkillArchiveError('The skill archive is cut short.')
    const data = tar.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK

    if (typeflag === 'x') {
      const pax = parsePax(data)
      if (pax.path !== undefined) paxPath = pax.path
      if (pax.size !== undefined) {
        if (!/^\d+$/.test(pax.size)) throw new SkillArchiveError('The skill archive has a damaged extended header.')
        paxSize = Number(pax.size)
      }
      continue
    }
    if (typeflag === 'g') continue
    if (typeflag === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (typeflag === 'K') continue

    const magic = cString(header, 257, 6)
    const prefix = magic.startsWith('ustar') ? cString(header, 345, 155) : ''
    const headerName = cString(header, 0, 100)
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${headerName}` : headerName)
    paxPath = null
    paxSize = null
    longName = null

    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({ path, type: 'file', mode: numeric(header, 100, 8), data })
    } else if (typeflag === '5') {
      entries.push({ path, type: 'dir', mode: numeric(header, 100, 8), data: Buffer.alloc(0) })
    } else if (typeflag === '1') {
      throw new SkillArchiveError('The skill archive holds a hard link, which a skill may not.')
    } else if (typeflag === '2') {
      throw new SkillArchiveError('The skill archive holds a symbolic link, which a skill may not.')
    } else {
      throw new SkillArchiveError('The skill archive holds something other than files and folders.')
    }
    if (entries.length > MAX_ENTRIES) throw new SkillArchiveError('The skill archive holds too many files.')
  }
  return entries
}

/** A member path's segments, or a refusal for an unsafe one. */
function segmentsOf(raw: string): string[] {
  if (raw.includes('\0') || raw.includes('\\')) throw new SkillArchiveError('The skill archive has an unusable file name.')
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new SkillArchiveError('The skill archive has a file outside its folder.')
  }
  const trimmed = raw.replace(/^\.\//, '').replace(/\/+$/, '')
  const segments = trimmed.split('/')
  for (const segment of segments) {
    if (segment === '..') throw new SkillArchiveError('The skill archive has a file outside its folder.')
    if (segment === '' || segment === '.') throw new SkillArchiveError('The skill archive has an unusable file name.')
  }
  return segments
}

/**
 * Parse and check a skill archive for the skill `name`.
 *
 * @throws SkillArchiveError for anything outside the rules in this module's header.
 */
export function readSkillArchive(gz: Buffer, name: string): SkillArchive {
  if (gz.length > MAX_ARCHIVE_BYTES) throw new SkillArchiveError('The skill archive is larger than 16 MB.')
  let tar: Buffer
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
      throw new SkillArchiveError('The skill archive unpacks to more than 64 MB.')
    }
    throw new SkillArchiveError('The skill archive is not a gzip file.')
  }
  const raw = readTar(tar).map((entry) => ({ ...entry, segments: segmentsOf(entry.path) }))

  // One root for everything: `skills/<name>/` (what core serves) or `<name>/`.
  // A folder entry may stand above the root (`skills/`); a file must be inside it.
  const under = (prefix: string[]): boolean =>
    raw.every(
      (entry) =>
        (entry.type === 'dir' || entry.segments.length > prefix.length) &&
        prefix.every((segment, index) => index >= entry.segments.length || entry.segments[index] === segment)
    )
  const root = under(['skills', name]) ? ['skills', name] : under([name]) ? [name] : null
  if (root === null) {
    throw new SkillArchiveError(`The skill archive does not hold exactly one folder named ${name}.`)
  }

  const dirs = new Set<string>()
  const files: SkillArchiveFile[] = []
  const seen = new Map<string, 'file' | 'dir'>()
  const claim = (path: string, type: 'file' | 'dir'): void => {
    const key = path.toLowerCase()
    const before = seen.get(key)
    if (before !== undefined && (before === 'file' || type === 'file')) {
      throw new SkillArchiveError('The skill archive holds the same file twice.')
    }
    seen.set(key, type)
  }
  for (const entry of raw) {
    const inner = entry.segments.slice(root.length)
    if (inner.length === 0) continue
    // Every folder above a member is implied, and must not also be a file.
    for (let depth = 1; depth < inner.length; depth++) {
      const parent = inner.slice(0, depth).join('/')
      claim(parent, 'dir')
      dirs.add(parent)
    }
    const path = inner.join('/')
    if (entry.type === 'dir') {
      claim(path, 'dir')
      dirs.add(path)
    } else {
      claim(path, 'file')
      files.push({ path, data: Buffer.from(entry.data), executable: (entry.mode & 0o111) !== 0 })
    }
  }
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new SkillArchiveError('The skill archive has no SKILL.md at the top of its folder.')
  }
  return { dirs: [...dirs].sort(), files }
}

/**
 * Lay a checked archive out as `<target>/` (which must not exist yet): files
 * 0444 (0555 when the archive marked them executable), folders 0555 once
 * their contents are written, the target itself included.
 */
export function writeSkillTree(target: string, archive: SkillArchive): void {
  mkdirSync(target, { recursive: false, mode: 0o755 })
  for (const dir of archive.dirs) mkdirSync(join(target, ...dir.split('/')), { recursive: true, mode: 0o755 })
  for (const file of archive.files) {
    const path = join(target, ...file.path.split('/'))
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o755 })
    writeFileSync(path, file.data, { flag: 'wx' })
    chmodSync(path, file.executable ? 0o555 : 0o444)
  }
  // Deepest first, so a parent is locked after its children.
  const folders = [...archive.dirs].sort((a, b) => b.split('/').length - a.split('/').length)
  for (const dir of folders) chmodSync(join(target, ...dir.split('/')), 0o555)
  chmodSync(target, 0o555)
}
