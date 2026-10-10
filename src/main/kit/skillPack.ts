/**
 * Packing an authored skill — `skills/<name>/` of a kit agent — for upload to
 * the catalog (`POST /api/v1/skills/packages/publish`, catalog U8), with no
 * dependency beyond `node:zlib` and `node:crypto`.
 *
 * What core's upload parser (`skill_upload.safe_extract`) accepts, and what
 * this writes: a gzip'd tar whose every member sits under **one top-level
 * folder named like the skill** (`<name>/SKILL.md`, `<name>/scripts/run.sh`;
 * `tar -C skills -czf x.tgz <name>`), regular files and folders only, at most
 * 2000 members and 16 MiB compressed. Core then drops `__pycache__`-style
 * junk while snapshotting and refuses secret-looking files, so both are dealt
 * with here first: the junk folders core's `skill_manifest.SKIP_DIR_NAMES` and
 * `workspace_classification.NESTED_EXCLUDED_*` name are left out, and secrets,
 * links and special files are reported for the caller to refuse.
 *
 * The archive is **deterministic**: members in byte order of their paths,
 * mtime 0, uid/gid 0, no user names, modes collapsed to 0755 (folders and
 * executables) or 0644, and the gzip header's mtime 0 and OS byte 255 — what
 * Python's `gzip` writes — so the same folder packs to the same bytes on any
 * computer. Paths longer than the 100-byte ustar field, or not plain ASCII,
 * travel in a pax `path` record.
 *
 * {@link skillTreeHash} is core's `PublishService.hash_workspace_tree` over the
 * snapshot root `<rev>/` (so every path starts `skills/<name>/`): the value
 * `publications.json` `skills[].content_hash` records.
 *
 * Core: `node:` builtins and pure helpers only.
 */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { isSecretFilename } from './skills'

/** Core's `MAX_PACKAGE_BYTES`: the compressed upload, and the files' total, may not pass it. */
export const MAX_SKILL_UPLOAD_BYTES = 16 * 1024 * 1024
/** Core's `MAX_ARCHIVE_MEMBERS`: files and folders, the skill's own folder included. */
export const MAX_SKILL_UPLOAD_MEMBERS = 2000

/**
 * Folders never packed, at any depth: core's `SKIP_DIR_NAMES` (what its
 * validator never walks) and `NESTED_EXCLUDED_DIRS` (what its snapshot copy
 * drops).
 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  '.git', '.venv', 'node_modules', '__pycache__', '.mypy_cache', '.ruff_cache', '.pytest_cache'
])
/** Files never packed, at any depth: core's `NESTED_EXCLUDED_FILE_GLOBS`. */
const SKIPPED_FILE_SUFFIXES = ['.pyc', '.pyo'] as const

export interface SkillTreeFile {
  /** POSIX path inside the skill folder, e.g. `SKILL.md`, `scripts/run.sh`. */
  path: string
  data: Buffer
  executable: boolean
}

export interface SkillTree {
  /** POSIX paths of the folders inside the skill folder (not the folder itself). */
  dirs: string[]
  files: SkillTreeFile[]
}

/** Why a skill folder cannot be packed; `paths` are inside the skill folder. */
export type SkillTreeProblem =
  | { problem: 'link'; paths: string[] }
  | { problem: 'special'; paths: string[] }
  | { problem: 'secrets'; paths: string[] }
  | { problem: 'unreadable'; paths: string[] }
  | { problem: 'too_large'; paths: [] }
  | { problem: 'too_many_files'; paths: [] }

/** Byte order of the UTF-8 encodings, which is code point order — Python's `sorted` on `str`. */
function byPath(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Read a skill folder into memory as it would be uploaded, or say why it
 * cannot be. Refusals come in a fixed order — links and special files, then
 * secrets, then a file that cannot be read, then size and count — and each
 * lists every offending path it found (in path order), not just the first.
 * Sizes are summed from `lstat` before any file is read, so an oversized
 * skill is refused without loading it.
 */
export function collectSkillTree(skillDir: string): { ok: true; tree: SkillTree } | ({ ok: false } & SkillTreeProblem) {
  const dirs: string[] = []
  const found: { path: string; abs: string; size: number; executable: boolean }[] = []
  const links: string[] = []
  const special: string[] = []
  const unreadable: string[] = []

  const walk = (abs: string, rel: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      unreadable.push(rel || '.')
      return
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const childAbs = join(abs, entry.name)
      if (entry.isSymbolicLink()) {
        links.push(childRel)
      } else if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue
        dirs.push(childRel)
        walk(childAbs, childRel)
      } else if (entry.isFile()) {
        if (SKIPPED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
        try {
          const stat = lstatSync(childAbs)
          found.push({ path: childRel, abs: childAbs, size: stat.size, executable: (stat.mode & 0o111) !== 0 })
        } catch {
          unreadable.push(childRel)
        }
      } else {
        special.push(childRel)
      }
    }
  }
  walk(skillDir, '')

  if (links.length > 0) return { ok: false, problem: 'link', paths: links.sort(byPath) }
  if (special.length > 0) return { ok: false, problem: 'special', paths: special.sort(byPath) }
  const secrets = found.filter((file) => isSecretFilename(file.path.slice(file.path.lastIndexOf('/') + 1))).map((file) => file.path)
  if (secrets.length > 0) return { ok: false, problem: 'secrets', paths: secrets.sort(byPath) }
  if (unreadable.length > 0) return { ok: false, problem: 'unreadable', paths: unreadable.sort(byPath) }
  if (found.reduce((total, file) => total + file.size, 0) > MAX_SKILL_UPLOAD_BYTES) return { ok: false, problem: 'too_large', paths: [] }
  // The skill's own folder is a member too.
  if (1 + dirs.length + found.length > MAX_SKILL_UPLOAD_MEMBERS) return { ok: false, problem: 'too_many_files', paths: [] }

  const files: SkillTreeFile[] = []
  for (const file of found.sort((a, b) => byPath(a.path, b.path))) {
    try {
      files.push({ path: file.path, data: readFileSync(file.abs), executable: file.executable })
    } catch {
      return { ok: false, problem: 'unreadable', paths: [file.path] }
    }
  }
  return { ok: true, tree: { dirs: dirs.sort(byPath), files } }
}

/* ------------------------------------------------------------------- tar */

const BLOCK = 512

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function ustarHeader(name: string, type: '0' | '5' | 'x', size: number, mode: number): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(mode, 8), 100, 'ascii')
  block.write(octal(0, 8), 108, 'ascii')
  block.write(octal(0, 8), 116, 'ascii')
  block.write(octal(size, 12), 124, 'ascii')
  block.write(octal(0, 12), 136, 'ascii')
  block.write(type, 156, 'ascii')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return block
}

function padded(data: Buffer): Buffer {
  const rest = data.length % BLOCK
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)])
}

/** One pax record, `<len> path=<value>\n`, whose length counts its own digits, in bytes. */
function paxPathRecord(path: string): Buffer {
  const body = Buffer.byteLength(` path=${path}\n`, 'utf8')
  let length = body + 1
  while (String(length).length + body !== length) length = String(length).length + body
  return Buffer.from(`${length} path=${path}\n`, 'utf8')
}

/** A member name the ustar field holds as is: printable ASCII within 100 bytes. */
function fitsUstar(name: string): boolean {
  return name.length <= 100 && /^[\x20-\x7e]*$/.test(name)
}

function member(parts: Buffer[], name: string, type: '0' | '5', mode: number, data: Buffer): void {
  if (!fitsUstar(name)) {
    const record = paxPathRecord(name)
    parts.push(ustarHeader('././@PaxHeader', 'x', record.length, 0o644), padded(record))
  }
  // The ustar field keeps what fits of a long or non-ASCII name; the pax record above wins.
  const fallback = fitsUstar(name) ? name : name.replace(/[^\x20-\x7e]/g, '_').slice(-100)
  parts.push(ustarHeader(fallback, type, type === '0' ? data.length : 0, mode))
  if (type === '0' && data.length > 0) parts.push(padded(data))
}

/**
 * The upload archive of `tree` as the skill `name`: `<name>/` first, then
 * every folder (`<name>/<dir>/`) and file in byte order of their paths, then
 * two zero blocks, gzip'd deterministically.
 */
export function packSkillTarGz(name: string, tree: SkillTree): Buffer {
  const parts: Buffer[] = []
  member(parts, `${name}/`, '5', 0o755, Buffer.alloc(0))
  const entries = [
    ...tree.dirs.map((path) => ({ path, file: null as SkillTreeFile | null })),
    ...tree.files.map((file) => ({ path: file.path, file }))
  ].sort((a, b) => byPath(a.path, b.path))
  for (const entry of entries) {
    if (entry.file === null) member(parts, `${name}/${entry.path}/`, '5', 0o755, Buffer.alloc(0))
    else member(parts, `${name}/${entry.path}`, '0', entry.file.executable ? 0o755 : 0o644, entry.file.data)
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  const gz = gzipSync(Buffer.concat(parts), { level: 9 })
  // The header's mtime is already 0; the OS byte varies by platform, so it is
  // set to 255 ("unknown"), as Python's gzip writes it.
  gz[9] = 0xff
  return gz
}

/**
 * Core's `hash_workspace_tree` over a skill snapshot: SHA-256 of
 * `skills/<name>/<path>` NUL `<bytes>` NUL for every file, in path order.
 */
export function skillTreeHash(name: string, files: readonly Pick<SkillTreeFile, 'path' | 'data'>[]): string {
  const hash = createHash('sha256')
  const rows = files.map((file) => ({ rel: `skills/${name}/${file.path}`, data: file.data })).sort((a, b) => byPath(a.rel, b.rel))
  for (const row of rows) {
    hash.update(Buffer.from(row.rel, 'utf8'))
    hash.update(Buffer.from([0]))
    hash.update(row.data)
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}
