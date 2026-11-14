/**
 * The Claude adapter tar for Agent Vault (D28): the patched
 * `@agentclientprotocol/claude-agent-acp` and its runtime dependency closure,
 * read from a checkout's `node_modules`, as one deterministic tar of
 * `node_modules/...` ({@link deterministicTar}: fixed order, owner, mode and
 * mtime). No platform binary package of the Claude Agent SDK goes in
 * (`CLAUDE_CODE_EXECUTABLE` names the pinned `claude`).
 *
 * Built once per app build (`electron.vite.config.ts` writes
 * {@link ADAPTER_TAR_PATH} under `out/`), so a packaged app ships it inside
 * app.asar, under asar integrity, and never re-reads its own
 * `app.asar.unpacked` tree, which electron-builder re-hoists and whose
 * `package.json` files it rewrites. Its sha256 is
 * `RUNTIME_PINS.claude.vaultAdapterTarSha256`, checked against this
 * checkout by `runtimeInstall.test.ts` (`npm run vault:pin-adapter`).
 *
 * Node builtins only: the build config imports this file.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, type Dirent } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Where the built tar sits, relative to the app path (the repo root in development, app.asar packaged). */
export const ADAPTER_TAR_PATH = 'out/vault/claude-adapter.tar'
/** The Codex adapter's tar, beside it ({@link codexAdapterFiles}). */
export const CODEX_ADAPTER_TAR_PATH = 'out/vault/codex-adapter.tar'

export class VaultRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultRuntimeError'
  }
}

export const ADAPTER_PACKAGE = '@agentclientprotocol/claude-agent-acp'
export const CODEX_ADAPTER_PACKAGE = '@agentclientprotocol/codex-acp'

/** Never shipped into a vault: a second `claude` the user never chose. */
function isPlatformBinaryPackage(name: string): boolean {
  return name.startsWith('@anthropic-ai/claude-agent-sdk-')
}

function findPackage(root: string, from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root || dirname(dir) === dir) return null
  }
}

/**
 * The adapter's runtime dependency closure: package directories, relative to
 * `root` (the folder holding `node_modules`), sorted. The same walk as the
 * packaging hook (`scripts/packaged-dependencies.cjs` `runtimePackages`).
 */
export function adapterClosure(root: string, entry = ADAPTER_PACKAGE): string[] {
  const visited = new Set<string>()
  const visit = (name: string, from: string, optional: boolean): void => {
    if (isPlatformBinaryPackage(name)) return
    const directory = findPackage(root, from, name)
    if (!directory) {
      if (optional) return
      throw new VaultRuntimeError(`The Claude adapter's dependency ${name} is missing from this installation.`)
    }
    if (visited.has(directory)) return
    visited.add(directory)
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const deps = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const dependency of Object.keys(deps)) {
      const optionalDependency = Object.hasOwn(pkg.optionalDependencies ?? {}, dependency)
      const optionalPeer = !Object.hasOwn(pkg.dependencies ?? {}, dependency) && pkg.peerDependenciesMeta?.[dependency]?.optional === true
      visit(dependency, directory, optionalDependency || optionalPeer)
    }
  }
  visit(entry, root, false)
  return [...visited].map((directory) => relative(root, directory).split(sep).join('/')).sort()
}

/**
 * What electron-builder leaves out when it copies a package into a packaged
 * app (`app-builder-lib` `NodeModuleCopyHelper` and `fileMatcher`, macOS
 * target): the closure is packed without them in development too, so a
 * checkout and a packaged app give the same tar and the same pin. None of it
 * is read at run time (docs, tests, type declarations, build leftovers).
 */
const PACKAGER_EXCLUDED_NAMES = new Set([
  '.DS_Store', 'CHANGELOG.md', 'ChangeLog', 'changelog.md', 'Changelog.md', 'Changelog', 'binding.gyp', '.npmignore', 'node_gyp_bins',
  '.git', '.hg', '.svn', 'CVS', 'RCS', 'SCCS', '__pycache__', 'thumbs.db', '.gitignore', '.gitkeep', '.gitattributes',
  '.idea', '.vs', '.flowconfig', '.jshintrc', '.eslintrc', '.circleci', '.yarn-integrity', '.yarn-metadata.json', 'yarn-error.log',
  'yarn.lock', 'package-lock.json', 'npm-debug.log', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'appveyor.yml', '.travis.yml',
  'circle.yml', '.nyc_output', '.husky', '.github', 'electron-builder.env'
])
const PACKAGER_TOP_LEVEL_EXCLUDED = new Set([
  'karma.conf.js', '.coveralls.yml', 'README.md', 'readme.markdown', 'README', 'readme.md', 'Readme.md', 'Readme', 'readme',
  'test', 'tests', '__tests__', 'powered-test', 'example', 'examples', '.bin'
])
const PACKAGER_EXCLUDED_EXTS = ['.o', '.obj', '.iml', '.hprof', '.orig', '.pyc', '.pyo', '.rbc', '.swp', '.csproj', '.sln', '.suo',
  '.xproj', '.cc', '.d.ts', '.mk', '.a', '.forge-meta', '.pdb', '.dll', '.exe']

function packagerSkips(name: string, dir: string, topLevel: boolean): boolean {
  if (PACKAGER_EXCLUDED_NAMES.has(name) || name.startsWith('._')) return true
  if (PACKAGER_EXCLUDED_EXTS.some((ext) => name.endsWith(ext))) return true
  if (topLevel && PACKAGER_TOP_LEVEL_EXCLUDED.has(name)) return true
  if (dir.endsWith('build') && (name === 'gyp-mac-tool' || name === 'Makefile' || name.endsWith('.gypi') || name.endsWith('.Makefile'))) return true
  if (dir.endsWith('Release') && (name === '.deps' || name === 'obj.target')) return true
  return false
}

/**
 * Every regular file of the closure, relative to `root`, sorted: nested
 * `node_modules` are their own closure members (or not needed), symlinks
 * (`.bin`) are left out, as the guest's archive check would refuse most, and
 * so is whatever a packaged app does not carry ({@link packagerSkips}).
 */
export function closureFiles(root: string, packages: readonly string[]): string[] {
  const files: string[] = []
  const walk = (rel: string, topLevel: boolean): void => {
    const entries: Dirent[] = readdirSync(join(root, rel), { withFileTypes: true })
    for (const entry of entries) {
      if (packagerSkips(entry.name, rel, topLevel)) continue
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(child, false)
      } else if (entry.isFile()) {
        files.push(child)
      }
    }
  }
  for (const pkg of packages) walk(pkg, true)
  return files.sort()
}

// ---------------------------------------------------------------------------
// The deterministic tar

const BLOCK = 512

function octalField(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

function tarHeader(name: string, size: number, mode: number, type: '0' | 'x'): Buffer {
  const header = Buffer.alloc(BLOCK)
  let entryName = name
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    // ustar: prefix (155) + "/" + name (100), split at a slash; the caller
    // sends a pax `path` record first when no split fits.
    const cut = name.lastIndexOf('/', name.length - 1)
    for (let at = cut; at > 0; at = name.lastIndexOf('/', at - 1)) {
      if (Buffer.byteLength(name.slice(0, at)) <= 155 && Buffer.byteLength(name.slice(at + 1)) <= 100) {
        prefix = name.slice(0, at)
        entryName = name.slice(at + 1)
        break
      }
    }
    if (!prefix) entryName = name.slice(0, 100)
  }
  header.write(entryName, 0, 100, 'utf8')
  header.write(octalField(mode, 8), 100, 8, 'ascii')
  header.write(octalField(0, 8), 108, 8, 'ascii') // uid
  header.write(octalField(0, 8), 116, 8, 'ascii') // gid
  header.write(octalField(size, 12), 124, 12, 'ascii')
  header.write(octalField(0, 12), 136, 12, 'ascii') // mtime
  header.write('        ', 148, 8, 'ascii') // checksum placeholder
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return header
}

function needsPax(name: string): boolean {
  if (Buffer.byteLength(name) <= 100) return false
  for (let at = name.lastIndexOf('/'); at > 0; at = name.lastIndexOf('/', at - 1)) {
    if (Buffer.byteLength(name.slice(0, at)) <= 155 && Buffer.byteLength(name.slice(at + 1)) <= 100) return false
  }
  return true
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body)
  for (;;) {
    const total = String(length).length + Buffer.byteLength(body)
    if (total === length) break
    length = total
  }
  return Buffer.from(`${length}${body}`, 'utf8')
}

function padding(size: number): Buffer {
  const rest = size % BLOCK
  return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest)
}

/**
 * A ustar of `files` (relative to `root`), in the given order, that depends
 * only on their paths, contents and whether each is executable: uid/gid 0, no
 * owner names, mtime 0, mode 0644 or 0755, no directory entries (extraction
 * makes the parents), pax `path` records only for names ustar cannot hold.
 * The same tree gives the same bytes on every machine, so its sha256 can be pinned.
 */
export async function* deterministicTar(root: string, files: readonly string[]): AsyncIterable<Uint8Array> {
  for (const file of files) {
    const path = join(root, ...file.split('/'))
    const stat = lstatSync(path)
    if (!stat.isFile()) throw new VaultRuntimeError(`${file} is not a regular file; refusing to pack it.`)
    const mode = stat.mode & 0o111 ? 0o755 : 0o644
    if (needsPax(file)) {
      const pax = paxRecord('path', file)
      yield tarHeader('././@PaxHeader', pax.length, 0o644, 'x')
      yield pax
      yield padding(pax.length)
    }
    // Streamed, not read whole: an engine runtime file can be most of a gigabyte.
    // The size in the header is the one the stream must deliver.
    yield tarHeader(file, stat.size, mode, '0')
    let sent = 0
    for await (const chunk of createReadStream(path)) {
      sent += (chunk as Buffer).length
      if (sent > stat.size) break
      yield chunk as Uint8Array
    }
    if (sent !== stat.size) throw new VaultRuntimeError(`${file} changed while it was being packed.`)
    yield padding(stat.size)
  }
  yield Buffer.alloc(BLOCK * 2)
}

/** The sha256 and size of {@link deterministicTar} over `files`. */
export async function deterministicTarSha256(root: string, files: readonly string[]): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of deterministicTar(root, files)) {
    hash.update(chunk)
    bytes += chunk.byteLength
  }
  return { sha256: hash.digest('hex'), bytes }
}

/** The files of the Claude adapter's closure under `root` (the folder holding `node_modules`), as packed. */
export function claudeAdapterFiles(root: string): string[] {
  return closureFiles(root, adapterClosure(root))
}

/**
 * The files of the Codex adapter under `root`: the `@agentclientprotocol/codex-acp`
 * package alone. Its `dist/index.js` is one bundle that imports nothing but
 * Node builtins (`runtimeInstall.test.ts` checks), so none of its declared
 * dependencies is needed — and one of them, `@openai/codex`, would pull a
 * second, host-platform `codex` binary in.
 */
export function codexAdapterFiles(root: string): string[] {
  const directory = join(root, 'node_modules', ...CODEX_ADAPTER_PACKAGE.split('/'))
  if (!existsSync(join(directory, 'package.json'))) {
    throw new VaultRuntimeError(`The Codex adapter ${CODEX_ADAPTER_PACKAGE} is missing from this installation.`)
  }
  return closureFiles(root, [`node_modules/${CODEX_ADAPTER_PACKAGE}`])
}

/** Write the adapter tar of the checkout at `root` to `outFile` (atomically); its sha256 and size. */
export async function writeClaudeAdapterTar(root: string, outFile: string): Promise<{ sha256: string; bytes: number }> {
  return writeDeterministicTar(root, claudeAdapterFiles(root), outFile)
}

/** {@link deterministicTar} of `files` (relative to `root`) written to `outFile` atomically; its sha256 and size. */
export async function writeDeterministicTar(root: string, files: readonly string[], outFile: string): Promise<{ sha256: string; bytes: number }> {
  mkdirSync(dirname(outFile), { recursive: true })
  const partial = `${outFile}.partial`
  const hash = createHash('sha256')
  let bytes = 0
  async function* counted(): AsyncIterable<Uint8Array> {
    for await (const chunk of deterministicTar(root, files)) {
      hash.update(chunk)
      bytes += chunk.byteLength
      yield chunk
    }
  }
  await pipeline(Readable.from(counted()), createWriteStream(partial))
  renameSync(partial, outFile)
  return { sha256: hash.digest('hex'), bytes }
}

/** The byte length {@link deterministicTar} gives for `files`, from their sizes alone. */
export function deterministicTarSize(root: string, files: readonly string[]): number {
  const padded = (size: number): number => Math.ceil(size / BLOCK) * BLOCK
  let total = BLOCK * 2
  for (const file of files) {
    if (needsPax(file)) total += BLOCK + padded(paxRecord('path', file).length)
    total += BLOCK + padded(lstatSync(join(root, ...file.split('/'))).size)
  }
  return total
}

/**
 * {@link writeClaudeAdapterTar}, unless `outFile` already is the pinned tar:
 * its size equals what the checkout's closure would give (cheap, from stat)
 * and its sha256 equals `pin`. Every build runs this, dev watch rebuilds
 * included, so an unchanged closure is not rewritten (44 MB) each time.
 */
export async function ensureClaudeAdapterTar(root: string, outFile: string, pin: string): Promise<{ sha256: string; bytes: number; written: boolean }> {
  return ensureDeterministicTar(root, claudeAdapterFiles(root), outFile, pin)
}

/** {@link ensureClaudeAdapterTar} for the Codex adapter ({@link codexAdapterFiles}, {@link CODEX_ADAPTER_TAR_PATH}). */
export async function ensureCodexAdapterTar(root: string, outFile: string, pin: string): Promise<{ sha256: string; bytes: number; written: boolean }> {
  return ensureDeterministicTar(root, codexAdapterFiles(root), outFile, pin)
}

async function ensureDeterministicTar(root: string, files: readonly string[], outFile: string, pin: string): Promise<{ sha256: string; bytes: number; written: boolean }> {
  if (existsSync(outFile)) {
    const bytes = statSync(outFile).size
    if (bytes === deterministicTarSize(root, files)) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(outFile)) hash.update(chunk as Uint8Array)
      const sha256 = hash.digest('hex')
      if (sha256 === pin) return { sha256, bytes, written: false }
    }
  }
  return { ...(await writeDeterministicTar(root, files, outFile)), written: true }
}
