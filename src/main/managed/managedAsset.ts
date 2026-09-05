/**
 * Installing a pinned, checksum-verified asset into a directory this app owns.
 *
 * This is the mechanism the OpenCode engine download grew first (see
 * `../engine/binaryResolver.ts`) and that the local-dev toolchain needs
 * verbatim for three more assets — uv, Mutagen, and anything after them. It is
 * extracted rather than copied because the part worth getting right is not the
 * download: it is what is on disk after a failure.
 *
 * ## The invariant
 *
 * **The presence of `installDir` is the proof that its bytes were verified.**
 *
 * Everything happens under a per-attempt `.staging-<pid>-<time>` directory, and
 * a single `rename` publishes it. Nothing partial, unverified or half-unpacked
 * ever appears at the install path, so callers can treat "the directory is
 * there" as "this install is good" and never re-check a digest at startup.
 * A crash mid-download leaves a `.staging-*` directory behind — junk, but junk
 * no code path will run — and {@link sweepStaging} clears it on the next pass.
 *
 * The same mechanism gives concurrency for free: two processes (or two
 * callers) both stage, and the loser of the `rename` race finds the winner's
 * directory already published. It keeps it, because it passed the same digest
 * check.
 *
 * ## What a digest proves, and what it does not
 *
 * A pinned SHA-256 says *these exact bytes*: a release re-tagged under the same
 * version, a compromised CDN edge, a proxy that injected a captive-portal page,
 * and a truncated transfer all fail it. It is **not** a signature — it
 * establishes that what arrived is what somebody at this repo verified once,
 * not that what they verified was trustworthy. That is why the digests live in
 * source, next to a note saying how they were computed, rather than being
 * fetched alongside the asset: a digest downloaded from the same place as the
 * bytes verifies nothing.
 *
 * A mismatch therefore **publishes nothing and retries nothing**. A corrupted
 * transfer and a substituted asset are indistinguishable from here, and
 * "download it again without the check" is precisely how a verification becomes
 * decoration.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type Dirent } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DomainError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('managed-asset')

/** Ceiling on the whole download. Generous — assets here run to tens of MB. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** Ceiling on the unpack. bsdtar on 50 MB is seconds; this only catches a hang. */
const EXTRACT_TIMEOUT_MS = 5 * 60_000

/**
 * Refuse an archive larger than this. Every asset pinned in this app is well
 * under 65 MB; the guard is against a redirect landing somewhere that streams
 * forever, which would fill the user's disk before the digest was ever checked.
 */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

/**
 * Stable failure codes. Callers map these onto user-facing state — the engine
 * onto its resolver errors, the toolchain onto Phase C's `attention` reasons —
 * so they are a contract, not log strings.
 */
export type ManagedAssetErrorCode =
  /** No pinned asset for this `${platform}-${arch}`. Not a crash: an explanation. */
  | 'unsupported_platform'
  /** The bytes never arrived: HTTP error, timeout, absurd size, dead socket. */
  | 'download_failed'
  /** The bytes arrived and were not the pinned ones. Nothing is published. */
  | 'checksum_mismatch'
  /** The archive would not unpack, or unpacked to something unrecognisable. */
  | 'extract_failed'

/**
 * Generic over its code so a caller can widen it with codes of its own
 * (`EngineBinaryError` adds the two "your configured path is wrong" cases)
 * while `err instanceof ManagedAssetError` still catches both families.
 */
export class ManagedAssetError<
  TCode extends string = ManagedAssetErrorCode
> extends DomainError<TCode> {}

/**
 * One release asset, pinned by name and by digest. Shared by every pin table in
 * the app (`ENGINE_ASSETS`, `UV_ASSETS`, `MUTAGEN_ASSETS`) so they cannot drift
 * into three shapes that mean the same thing.
 */
export interface PinnedAsset {
  /** Asset file name in the release. */
  file: string
  /** SHA-256 of the asset's exact bytes, hex. */
  sha256: string
}

export async function isFile(path: string): Promise<boolean> {
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
 * Find a file called `name` somewhere under `dir`, breadth-first, to `depth`
 * levels of subdirectory.
 *
 * Release archives disagree about nesting for no reason a consumer can predict:
 * the OpenCode macOS zips hold the binary at the root, its Linux tarballs nest
 * it one level down, the uv tarballs nest under `uv-<target>/`, and the Mutagen
 * tarballs are flat. Rather than encode each shape — a table that would be
 * wrong the first time an upstream changed its packaging — walk a couple of
 * levels and take the first match. Returning `null` rather than guessing is the
 * point of the other half: an archive that unpacked to something else entirely
 * is exactly the case where "use whatever executable is in there" installs
 * nonsense.
 */
export async function findNamedFile(
  dir: string,
  name: string,
  depth = 2
): Promise<string | null> {
  // Explicitly typed rather than inferred from `readdir`: the declaration has a
  // Buffer overload, and `ReturnType<typeof readdir>` picks *that* one, which
  // then types every `entry.name` as a Buffer and breaks the string compares
  // below in a way whose error message points nowhere near the cause.
  const entries = await readdir(dir, { withFileTypes: true }).catch((): Dirent<string>[] => [])
  const dirs: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) dirs.push(full)
  }
  if (depth <= 0) return null
  for (const sub of dirs) {
    const found = await findNamedFile(sub, name, depth - 1)
    if (found) return found
  }
  return null
}

/**
 * Remove `.staging-*` leftovers under `root`.
 *
 * These only exist because a previous run was killed — a crash, a quit, a
 * laptop lid — between staging and the publishing rename. Sweeping is
 * best-effort and never fatal: a directory that will not delete (a permission
 * oddity, a file still open) costs disk, while refusing to install over it
 * would cost the user their toolchain.
 *
 * An install running *in this process* is exempt, and that exemption is load
 * bearing rather than tidy. The toolchain leaves a download running when a
 * concurrent sibling fails, precisely so the next pass can join it instead of
 * starting the megabytes again — and that next pass sweeps before it joins.
 * Without {@link liveStaging} it would delete the directory of the download it
 * is about to wait on, which then dies at its own checksum with an ENOENT that
 * looks like a corrupt release.
 *
 * Deliberately *not* aggressive about age or ownership beyond that: a
 * concurrently running second *instance* has its own `.staging-<pid>-<time>-<n>`
 * and would be swept out from under itself. That race is survivable — the
 * loser's `rename` fails and it falls back to whatever was published — and
 * parsing pids out of directory names and probing liveness is more machinery
 * than the failure justifies. Callers sweep once at the start of a pass, not
 * per asset.
 */
export async function sweepStaging(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch((): Dirent<string>[] => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.staging-')) continue
    const path = join(root, entry.name)
    if (liveStaging.has(path)) continue
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface InstallPinnedAssetOptions {
  /** Parent dir holding installs and `.staging-*` (`<userData>/engine`, `<userData>/localdev`). */
  root: string
  /** Absolute path to publish to. Its presence is the proof bytes were verified. */
  installDir: string
  /** Log label, e.g. 'engine' | 'uv' | 'mutagen'. Also names the asset in error text. */
  label: string
  /** File name to stage the download under. Cosmetic; it never leaves staging. */
  archiveName: string
  url: string
  sha256: string
  /** Find, inside the unpacked tree, the directory to rename into `installDir`. */
  locate: (unpackedDir: string) => Promise<string | null>
  /** True when `installDir` already holds a good install (checked before work and after a lost rename race). */
  isInstalled: () => Promise<boolean>
  /**
   * Byte progress for the download stage, when the caller has somewhere to put
   * it. Nothing else here is measurable — the digest and the unpack are seconds
   * on a tree that is already local — so this is the only honest source of a
   * moving number, and the caller decides what fraction of its own bar the
   * download is worth.
   */
  onDownloadProgress?: DownloadProgress
  download: (url: string, dest: string, onProgress?: DownloadProgress) => Promise<void>
  extract: (archive: string, dest: string) => Promise<void>
  /**
   * Message for the `extract_failed` raised when {@link locate} finds nothing.
   * Worth a caller-supplied string: "the archive did not contain X" is the one
   * failure here a user can sometimes act on, and it needs to name X.
   */
  notFoundMessage?: string
}

/**
 * Install a pinned asset into `installDir`, unless it is already there.
 *
 * Returns `{ installed: false }` when the work was skipped because the install
 * already existed — the caller usually does not care, but a progress reporter
 * does, and so does a test asserting that a second `ensure` downloads nothing.
 */
/** Distinguishes staging directories created within the same millisecond. */
let stagingSeq = 0

/**
 * Staging directories an install in *this* process is using right now.
 *
 * Read by {@link sweepStaging}, which must not delete them: an install can
 * outlive the pass that started it (see the toolchain's concurrent installs),
 * and the next pass sweeps before it joins the one still running.
 */
const liveStaging = new Set<string>()

export async function installPinnedAsset(
  o: InstallPinnedAssetOptions
): Promise<{ installed: boolean }> {
  if (await o.isInstalled()) return { installed: false }

  await mkdir(o.root, { recursive: true })
  // The counter is what makes this safe for two installs running at once —
  // the toolchain downloads uv and Mutagen in parallel, and a pid and a
  // millisecond are not enough to tell those two apart.
  const staging = join(o.root, `.staging-${process.pid}-${Date.now()}-${++stagingSeq}`)
  const unpacked = join(staging, 'unpacked')
  const archive = join(staging, o.archiveName)
  liveStaging.add(staging)

  try {
    await mkdir(unpacked, { recursive: true })
    logger.info('downloading a pinned asset', { label: o.label, url: o.url })
    await o.download(o.url, archive, o.onDownloadProgress)

    const digest = await sha256File(archive)
    if (digest !== o.sha256) {
      // Loud, and nothing survives it. Logging both digests is what makes a
      // genuine upstream re-tag diagnosable in a user's log without asking them
      // to re-run anything.
      logger.error('a pinned asset failed verification', {
        label: o.label,
        url: o.url,
        expected: o.sha256,
        actual: digest
      })
      throw new ManagedAssetError(
        'checksum_mismatch',
        `The downloaded ${o.label} did not match its expected checksum, so it was discarded. Check your connection and try again.`
      )
    }

    await o.extract(archive, unpacked)
    const found = await o.locate(unpacked)
    if (!found) {
      throw new ManagedAssetError(
        'extract_failed',
        o.notFoundMessage ?? `The downloaded ${o.label} archive did not contain what was expected.`
      )
    }
    if (process.platform !== 'win32') await chmod(found, 0o755)

    // Publish the *directory that holds the located file*, not the whole
    // staging tree, so the final layout is the same regardless of how the
    // archive nested it — and so `installDir` never contains the archive it
    // came from.
    try {
      await rename(dirname(found), o.installDir)
    } catch (err) {
      // Lost the race: another caller published first. Its tree passed the same
      // digest check, so keep it and report success.
      if (!(await o.isInstalled())) throw err
      logger.info('another install published first; keeping it', { label: o.label })
      return { installed: false }
    }
    logger.info('installed a pinned asset', { label: o.label, installDir: o.installDir })
    return { installed: true }
  } finally {
    liveStaging.delete(staging)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
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
/**
 * How a download reports itself: bytes so far, and the total when the server
 * declared one.
 *
 * `total` is `null` rather than a guess when `content-length` is absent — a
 * chunked response has no length, and a progress bar filled from an invented
 * denominator is worse than an honest one that only counts up.
 */
export type DownloadProgress = (received: number, total: number | null) => void

/**
 * Report at most this often. A 40 MB asset arrives in thousands of chunks and
 * every one of these crosses an IPC boundary and re-renders a React tree; the
 * eye cannot use more than a handful a second anyway.
 */
const PROGRESS_INTERVAL_MS = 150

export async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: DownloadProgress
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new ManagedAssetError(
        'download_failed',
        `Could not download ${url} (HTTP ${response.status}).`
      )
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_ARCHIVE_BYTES) {
      throw new ManagedAssetError('download_failed', 'The download was unexpectedly large.')
    }
    const sink = createWriteStream(dest)
    let total = 0
    let lastReport = 0
    // The same counter that guards the size is what feeds the progress bar:
    // one place that knows how many bytes have arrived, so a bar can never
    // disagree with the limit that is actually enforced.
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > MAX_ARCHIVE_BYTES) {
          throw new ManagedAssetError('download_failed', 'The download was unexpectedly large.')
        }
        const now = Date.now()
        if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          onProgress(total, declared > 0 ? declared : null)
        }
        controller.enqueue(chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body.pipeThrough(counted) as never), sink)
    // A final report, so a bar that was throttled mid-chunk lands on 100%
    // rather than stopping at whatever the last tick happened to be.
    onProgress?.(total, declared > 0 ? declared : total)
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
 * Every shape this app pins is handled by one command: `bsdtar` — macOS's
 * `/usr/bin/tar` and Windows 10 1803+'s `tar.exe` — reads zip as well as
 * tar.gz, and Linux only ever gets a tar.gz. That is worth a sentence because
 * the obvious reading of "we `tar -xf` a `.zip`" is that it cannot work.
 *
 * The alternative was an unzip dependency, which is still not worth adding.
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
      finish(new ManagedAssetError('extract_failed', 'Unpacking the download timed out.'))
    }, EXTRACT_TIMEOUT_MS)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) =>
      finish(new ManagedAssetError('extract_failed', `Could not unpack the download: ${err.message}`))
    )
    child.on('close', (code) =>
      finish(
        code === 0
          ? null
          : new ManagedAssetError(
              'extract_failed',
              `Could not unpack the download: ${stderr.trim().slice(0, 200) || `tar exited ${code}`}`
            )
      )
    )
  })
}
