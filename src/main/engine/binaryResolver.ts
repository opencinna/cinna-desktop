/**
 * Finding an `opencode` binary to run folder agents with.
 *
 * Three sources, in this order:
 *
 * 1. **A path the user configured** in Settings → Local Agents. An explicit
 *    override always wins; no version pin is applied to it, because the whole
 *    point is "run the one I told you to".
 * 2. **A user-installed `opencode` on the login-shell PATH.** Preferred over
 *    downloading, because a developer who already has one keeps their own
 *    install, their own auth and their own update cadence — and because the
 *    download is 46 MB the app then owns forever. The lookup is Phase 4's
 *    {@link which}; there is deliberately no second PATH walker in this repo.
 * 3. **The pinned version this app downloads** into
 *    `app.getPath('userData')/engine/`, verified against a SHA-256 recorded in
 *    {@link ENGINE_ASSETS} before anything is unpacked.
 *
 * TODO(packaging): shipping per-platform `opencode` binaries inside the app as
 * `extraResources` is deliberately deferred to a later packaging task. It needs
 * three things this phase does not: an `extraResources` block in
 * `electron-builder.yml` (there is none today — see seam 14 of
 * `plans/local-agents.md`), proof that a Bun single-file executable launches
 * from a signed and notarised macOS bundle, and a fourth branch here that
 * prefers `process.resourcesPath` over the download. Until then a bundled copy
 * would be a large untested asset in every installer, so the download path is
 * the shipping one and this note is the record of why.
 *
 * ## What "verify the download" means, and what it does not
 *
 * The digests below were computed by downloading each asset from the pinned
 * release and hashing it. They pin *these exact bytes*: a release re-tagged
 * under the same version, a compromised CDN edge, or a truncated transfer all
 * fail the check and nothing is unpacked. They are **not** a signature — they
 * establish that what arrives is what was pinned, not that what was pinned is
 * trustworthy. Bumping the version means recomputing all six.
 *
 * A failed verification must leave nothing behind that a later run could
 * mistake for a good install. Everything happens in a staging directory and
 * only a fully downloaded, verified, unpacked tree is renamed into its final
 * name — so the presence of `<engine>/opencode-<version>/opencode` *is* the
 * proof that its bytes were checked.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type Dirent } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import { createLogger } from '../logger/logger'
import { which } from '../shell/env'
import { PINNED_ENGINE_VERSION, type EngineBinarySource } from '../../shared/engine'

const logger = createLogger('engine-binary')

/** Executable name, per platform. */
const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'

/** Ceiling on the `--version` probe. A wedged binary must not wedge a start. */
const VERSION_TIMEOUT_MS = 10_000

/** Ceiling on the whole download. Generous — this is ~50 MB over the internet. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** Ceiling on the unpack. bsdtar on 50 MB is seconds; this only catches a hang. */
const EXTRACT_TIMEOUT_MS = 5 * 60_000

/**
 * Refuse an archive larger than this. The pinned assets are all under 65 MB;
 * the guard is against a redirect landing somewhere that streams forever, which
 * would otherwise fill the user's disk before the digest was ever checked.
 */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

export interface EngineAsset {
  /** Asset file name in the release. */
  file: string
  /** SHA-256 of the asset's exact bytes, hex. */
  sha256: string
}

/**
 * The pinned release assets, keyed `${process.platform}-${process.arch}`.
 *
 * Only the platforms listed here can be auto-installed. A platform that is
 * absent is not a crash — {@link resolveEngineBinary} says plainly that the
 * user has to install `opencode` themselves, which is a supportable answer.
 * Inventing a digest for a platform nobody verified would not be.
 *
 * Linux uses the glibc builds. A musl-only distribution (Alpine) is the known
 * gap: the release has `-musl` variants, but detecting libc reliably from Node
 * is its own small project, and Alpine is not a target this desktop app builds
 * for today. Such a user installs `opencode` themselves and source 2 finds it.
 */
export const ENGINE_ASSETS: Readonly<Record<string, EngineAsset>> = {
  'darwin-arm64': {
    file: 'opencode-darwin-arm64.zip',
    sha256: '149b0c6d272d0059b8b5ffcd18c84b24f1d6cbf585942b10e60c601211992eb1'
  },
  'darwin-x64': {
    file: 'opencode-darwin-x64.zip',
    sha256: 'e182eab3a6bf095ff773d303bbc7938d3551a636eab00625b599ad6383fabd88'
  },
  'linux-x64': {
    file: 'opencode-linux-x64.tar.gz',
    sha256: '4af5494f9433f59db8c1e344198f0ee72a50c06ec009fb4a8aeab4c2d4abd702'
  },
  'linux-arm64': {
    file: 'opencode-linux-arm64.tar.gz',
    sha256: '8cbc134eb5e100baf61ee7196150f503e352056e703276e2d8637c38bafd2c39'
  },
  'win32-x64': {
    file: 'opencode-windows-x64.zip',
    sha256: 'ac26bb6f0309e9a6de279b64dc7bec5e69ab9b79c1a4e2d947d68d213b7eb575'
  },
  'win32-arm64': {
    file: 'opencode-windows-arm64.zip',
    sha256: '59174ffeb6ce327bd2c534bf5147d0005e8db3b5889414de10490d00e640c908'
  }
}

/** Release download root for the pinned version. */
export function assetUrl(version: string, file: string): string {
  return `https://github.com/anomalyco/opencode/releases/download/v${version}/${file}`
}

export interface ResolvedEngineBinary {
  path: string
  source: EngineBinarySource
  /** `opencode --version`, or null when the probe failed but the file runs. */
  version: string | null
}

/**
 * Everything this module touches that a test wants to replace.
 *
 * Injected rather than module-mocked because the interesting cases here are
 * *failures* — a digest that does not match, an extraction that produces no
 * binary, a download that dies half way — and each of those has to be
 * reproducible without a network.
 */
export interface BinaryResolverDeps {
  /** Explicit path from Settings, or null/empty for "resolve one for me". */
  configuredPath: () => string | null
  /** Phase 4's login-shell PATH lookup. */
  which: (bin: string) => Promise<string | null>
  /** `<userData>/engine`. */
  engineRoot: () => string
  /** Stream a URL to a file. Must not create the file unless bytes arrive. */
  download: (url: string, dest: string) => Promise<void>
  /** Unpack `archive` into the (already created) directory `dest`. */
  extract: (archive: string, dest: string) => Promise<void>
  /** `<binary> --version`, or null when it will not run. */
  probeVersion: (path: string) => Promise<string | null>
  /** Key into {@link assets}. Injected so a test can ask for any platform. */
  platformKey: () => string
  /**
   * The pin table. Injected rather than read from the module constant so a test
   * can pin a digest it computed itself — the failure that matters here is a
   * *mismatch*, and a test that cannot produce one is not testing verification.
   */
  assets: Readonly<Record<string, EngineAsset>>
  version: string
}

export class EngineBinaryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'EngineBinaryError'
    this.code = code
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** SHA-256 of a file's bytes, hex, streamed so a 50 MB archive is not buffered. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Find the `opencode` executable somewhere under `dir`.
 *
 * The macOS and Windows archives hold the binary at the root; the Linux
 * tarballs have historically nested it one level down. Rather than encode
 * either shape, walk a couple of levels and take the first match — and fail
 * loudly if there is none, because an archive that unpacked to something else
 * entirely is exactly the case where guessing would install nonsense.
 */
async function findBinary(dir: string, depth = 2): Promise<string | null> {
  // Explicitly typed rather than inferred from `readdir`: the declaration has a
  // Buffer overload, and `ReturnType<typeof readdir>` picks *that* one, which
  // then types every `entry.name` as a Buffer and breaks the string compares
  // below in a way whose error message points nowhere near the cause.
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (): Dirent<string>[] => []
  )
  const dirs: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === BINARY_NAME) return full
    if (entry.isDirectory()) dirs.push(full)
  }
  if (depth <= 0) return null
  for (const sub of dirs) {
    const found = await findBinary(sub, depth - 1)
    if (found) return found
  }
  return null
}

/**
 * Install the pinned engine into `<engineRoot>/opencode-<version>/`, if it is
 * not already there.
 *
 * Concurrency and crash safety come from the same mechanism: all work happens
 * under a per-attempt staging directory, and the final `rename` is the only
 * thing that publishes it. A crash mid-download leaves a `.staging-*` directory
 * — junk, but junk that no code path treats as an install — and a second caller
 * that wins the race simply finds the directory already there and keeps it.
 */
async function installPinned(deps: BinaryResolverDeps): Promise<ResolvedEngineBinary> {
  const key = deps.platformKey()
  const asset = deps.assets[key]
  if (!asset) {
    throw new EngineBinaryError(
      'unsupported_platform',
      `Cinna has no verified opencode build for ${key}. Install opencode yourself and it will be picked up, or set the engine path in Settings.`
    )
  }

  const root = deps.engineRoot()
  const installDir = join(root, `opencode-${deps.version}`)
  const installed = join(installDir, BINARY_NAME)
  if (await isFile(installed)) {
    return { path: installed, source: 'managed', version: await deps.probeVersion(installed) }
  }

  await mkdir(root, { recursive: true })
  const staging = join(root, `.staging-${process.pid}-${Date.now()}`)
  const unpacked = join(staging, 'unpacked')
  const archive = join(staging, asset.file)

  try {
    await mkdir(unpacked, { recursive: true })
    const url = assetUrl(deps.version, asset.file)
    logger.info('downloading the engine', { version: deps.version, platform: key })
    await deps.download(url, archive)

    const digest = await sha256File(archive)
    if (digest !== asset.sha256) {
      // Loud, and nothing survives it. A mismatch is either a corrupted
      // transfer or a substituted asset, and the two are indistinguishable
      // from here — so both are refused rather than "retried without the
      // check", which is how a verification quietly becomes decoration.
      logger.error('engine download failed verification', {
        platform: key,
        expected: asset.sha256,
        actual: digest
      })
      throw new EngineBinaryError(
        'checksum_mismatch',
        'The downloaded engine did not match its expected checksum, so it was discarded. Check your connection and try again.'
      )
    }

    await deps.extract(archive, unpacked)
    const found = await findBinary(unpacked)
    if (!found) {
      throw new EngineBinaryError(
        'extract_failed',
        'The downloaded engine archive did not contain an opencode executable.'
      )
    }
    if (process.platform !== 'win32') await chmod(found, 0o755)

    // Publish the *directory that holds the binary*, not the whole staging
    // tree, so the final layout is `<root>/opencode-<version>/opencode`
    // regardless of how the archive nested it.
    const src = dirname(found)
    try {
      await rename(src, installDir)
    } catch (err) {
      // Lost the race: another caller published first. Its tree passed the
      // same digest check, so keep it.
      if (!(await isFile(installed))) throw err
    }
    logger.info('engine installed', { version: deps.version, platform: key })
    return { path: installed, source: 'managed', version: await deps.probeVersion(installed) }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Resolve a binary through the three sources, in order.
 *
 * A configured path that is not a runnable file is an **error**, not a silent
 * fallback: the user pointed at something specific, and quietly running a
 * different engine than the one they named is worse than saying the path is
 * wrong.
 */
export async function resolveEngineBinaryWith(
  deps: BinaryResolverDeps
): Promise<ResolvedEngineBinary> {
  const configured = deps.configuredPath()?.trim()
  if (configured) {
    if (!(await isFile(configured))) {
      throw new EngineBinaryError(
        'configured_missing',
        'The engine path in Settings does not point at a file. Fix it, or clear it to let Cinna find one.'
      )
    }
    const version = await deps.probeVersion(configured)
    if (version === null) {
      throw new EngineBinaryError(
        'configured_unusable',
        'The engine path in Settings points at a file that will not run. Fix it, or clear it to let Cinna find one.'
      )
    }
    return { path: configured, source: 'configured', version }
  }

  const onPath = await deps.which('opencode')
  if (onPath) {
    const version = await deps.probeVersion(onPath)
    // A `which` hit that will not run is not fatal — fall through to the
    // managed copy rather than stranding the user on a broken install.
    if (version !== null) return { path: onPath, source: 'path', version }
    logger.warn('an opencode on PATH would not run; falling back to the managed engine')
  }

  return installPinned(deps)
}

/** `<binary> --version`, or null when the file will not run. */
export function probeEngineVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(null)
    }, VERSION_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      const trimmed = out.trim().split('\n')[0]?.trim() ?? ''
      finish(code === 0 && trimmed !== '' ? trimmed : null)
    })
  })
}

/**
 * Stream a URL to a file, following redirects (GitHub release assets always
 * redirect to a CDN).
 *
 * `fetch` is Node's built-in and Electron's — no dependency is added for this.
 * The bytes go to disk as they arrive rather than into memory, and the file is
 * removed if anything goes wrong, so the caller's digest check is never handed
 * a truncated file that happens to exist.
 */
export async function downloadToFile(url: string, dest: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new EngineBinaryError(
        'download_failed',
        `Could not download the engine (HTTP ${response.status}).`
      )
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_ARCHIVE_BYTES) {
      throw new EngineBinaryError('download_failed', 'The engine download was unexpectedly large.')
    }
    const sink = createWriteStream(dest)
    let total = 0
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > MAX_ARCHIVE_BYTES) {
          throw new EngineBinaryError(
            'download_failed',
            'The engine download was unexpectedly large.'
          )
        }
        controller.enqueue(chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body.pipeThrough(counted) as never), sink)
  } catch (err) {
    await rm(dest, { force: true }).catch(() => undefined)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Unpack an archive with the system `tar`.
 *
 * Both shapes the release ships are handled by one command: `bsdtar` — macOS's
 * `/usr/bin/tar` and Windows 10 1803+'s `tar.exe` — reads zip as well as
 * tar.gz, and Linux only ever gets a tar.gz. That is worth a sentence because
 * the obvious reading of "we `tar -xf` a `.zip`" is that it cannot work.
 *
 * The alternative was an unzip dependency, which this phase is not adding.
 */
export function extractArchive(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(new EngineBinaryError('extract_failed', 'Unpacking the engine timed out.'))
    }, EXTRACT_TIMEOUT_MS)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) =>
      finish(new EngineBinaryError('extract_failed', `Could not unpack the engine: ${err.message}`))
    )
    child.on('close', (code) =>
      finish(
        code === 0
          ? null
          : new EngineBinaryError(
              'extract_failed',
              `Could not unpack the engine: ${stderr.trim().slice(0, 200) || `tar exited ${code}`}`
            )
      )
    )
  })
}

/** The engine's own directory inside the app data dir. Never the agents home. */
export function engineRootDir(): string {
  return join(app.getPath('userData'), 'engine')
}

export function realBinaryResolverDeps(configuredPath: () => string | null): BinaryResolverDeps {
  return {
    configuredPath,
    which,
    engineRoot: engineRootDir,
    download: downloadToFile,
    extract: extractArchive,
    probeVersion: probeEngineVersion,
    platformKey: () => `${process.platform}-${process.arch}`,
    assets: ENGINE_ASSETS,
    version: PINNED_ENGINE_VERSION
  }
}
