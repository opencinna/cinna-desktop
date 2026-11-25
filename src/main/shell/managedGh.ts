/**
 * A GitHub CLI of Cinna's own, for a machine that has none.
 *
 * The GitHub repos feature hands agents an authenticated `gh` (G5 in
 * `plans/github-repos`). Any `gh` the user installed — Homebrew, a distro
 * package, the official installer — wins; on a machine without one the app
 * downloads the CLI's own release archive (`cli/cli`, pinned in
 * `RUNTIME_PINS.gh`) into `<userData>/runtimes/gh-<version>/` and runs
 * `bin/gh` from there. Unlike the managed git (`managedGit.ts`) it needs no
 * wrapper: `gh` is one static executable that runs from anywhere.
 *
 * ## When it downloads
 *
 * Never at startup and never awaited: {@link ManagedGh.ensureInstalled} is
 * called by the install triggers — a completed GitHub sign-in, and a `gh`
 * wrapper call that finds none — and starts at most one install per app run.
 * After a failure it does not try again until the next run (a warning in the
 * log, no UI). A tree that downloaded and verified but will not run here — no
 * `bin/gh`, or a `--version` answer that is not the pin — would fail the same
 * way on every start, so that failure leaves a marker,
 * `<runtimes>/.gh-<version>-unsupported`, and this version is never downloaded
 * on this machine again; a new pin has a new marker name. A network or
 * checksum failure leaves none. `CINNA_GH_DOWNLOAD=off` turns it off, which
 * the E2E fixture does on every launch. Core module: no Electron import.
 */

import { execFile } from 'node:child_process'
import { existsSync, type Dirent } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'
import {
  downloadToFile,
  extractArchive,
  isFile,
  installPinnedAsset,
  markUsed,
  sweepStaging,
  sweepSuperseded
} from '../managed/managedAsset'
import { RUNTIME_PINS, type RuntimePinAsset } from '../../shared/runtimePins'

const logger = createLogger('managed-gh')

const VERSION_TIMEOUT_MS = 10_000

/** How often a confirmed install re-stamps its tree as used (`markUsed`); the sweep keeps a week. */
export const MARK_USED_INTERVAL_MS = 60 * 60 * 1000

/**
 * Beside the version directories in `runtimes/`, and dot-prefixed so neither
 * sweep (`.staging-*` directories, `gh-<digit>…` directories) ever takes it.
 */
export function unsupportedMarkerName(version: string): string {
  return `.gh-${version}-unsupported`
}

/**
 * Does the first line of `gh --version` name exactly the pin? `gh` follows
 * the version with its build date (`gh version 2.105.0 (2026-11-17)`), so the
 * line is the pin's `versionOutput` alone or followed by a space — never a
 * prefix of a longer version (`2.105.01`).
 */
export function answersPin(line: string | null, versionOutput: string): boolean {
  return line !== null && (line === versionOutput || line.startsWith(`${versionOutput} `))
}

/**
 * `bin/gh` inside the unpacked archive. The release nests it one level down
 * (`gh_<version>_<plat>/bin/gh`); a tree packed without that directory is
 * accepted too.
 */
async function locateGh(unpacked: string): Promise<string | null> {
  const direct = join(unpacked, 'bin', 'gh')
  if (await isFile(direct)) return direct
  const entries = await readdir(unpacked, { withFileTypes: true }).catch((): Dirent<string>[] => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = join(unpacked, entry.name, 'bin', 'gh')
    if (await isFile(nested)) return nested
  }
  return null
}

export interface ManagedGhDeps {
  /** `${platform}-${arch}`, the key into the pin table. */
  platformKey: string
  assets: Readonly<Record<string, RuntimePinAsset>>
  version: string
  /** What the first line of the pinned `gh --version` starts with (see {@link answersPin}). */
  versionOutput: string
  /** `<userData>/runtimes` — shared with the engine runtimes and the managed git, and swept alike. */
  runtimesRoot: () => string
  /** False under `CINNA_GH_DOWNLOAD=off`. */
  downloadEnabled: () => boolean
  /** Stream `url` to `dest`; `expectedBytes` is the pinned size, the download's ceiling. */
  download: (url: string, dest: string, expectedBytes?: number) => Promise<void>
  extract: (archive: string, dest: string) => Promise<void>
  /** First line of `<gh> --version`, or null. */
  probeVersion: (gh: string) => Promise<string | null>
  /** Clock for the `markUsed` throttle; `Date.now` unless a test drives it. */
  now?: () => number
}

export function createManagedGh(deps: ManagedGhDeps) {
  const asset = deps.assets[deps.platformKey]
  let inFlight: Promise<void> | null = null
  /** Set by a failed install: no second attempt in this run. */
  let failed = false
  /** When {@link binaryPath} last stamped the tree as used. */
  let markedUsedAt = Number.NEGATIVE_INFINITY
  const now = deps.now ?? Date.now

  const root = (): string => join(deps.runtimesRoot(), `gh-${deps.version}`)
  const binaryLocation = (): string => join(root(), 'bin', 'gh')
  const marker = (): string => join(deps.runtimesRoot(), unsupportedMarkerName(deps.version))

  async function install(): Promise<void> {
    if (!asset?.url) return
    const runtimes = deps.runtimesRoot()
    /** Why `locate` refused the verified tree, if it did: a failure that will recur. */
    let rejected: string | null = null
    const { installed: published } = await installPinnedAsset({
      root: runtimes,
      installDir: root(),
      label: 'gh',
      archiveName: asset.file,
      url: asset.url,
      sha256: asset.sha256,
      locate: async (unpacked) => {
        const gh = await locateGh(unpacked)
        if (!gh) {
          rejected = 'no bin/gh in the archive'
          return null
        }
        // Run from staging: a tree that does not answer with the pin is never published.
        const answer = await deps.probeVersion(gh)
        if (!answersPin(answer, deps.versionOutput)) {
          logger.warn('the downloaded gh failed its version check', { answer })
          rejected = `version check answered ${JSON.stringify(answer)}`
          return null
        }
        return gh
      },
      // The directory holding `bin/` (with `LICENSE` and `share/man`), so the
      // binary lands at `gh-<version>/bin/gh` however the archive nested it.
      publishDir: (gh) => dirname(dirname(gh)),
      isInstalled: () => isFile(binaryLocation()),
      download: (url, dest) => deps.download(url, dest, asset.size),
      extract: deps.extract,
      notFoundMessage: `The downloaded gh archive did not hold a bin/gh that reports version ${deps.version}.`
    }).catch(async (error: unknown) => {
      if (rejected !== null) {
        await writeFile(marker(), `${rejected}\n`).catch((markError: unknown) =>
          logger.warn('could not record the managed gh as unsupported', { error: String(markError) })
        )
      }
      throw error
    })
    if (published) {
      logger.info('installed a managed gh', { version: deps.version })
      await sweepSuperseded(runtimes, 'gh', `gh-${deps.version}`)
    }
  }

  function installed(): Promise<boolean> {
    if (!asset) return Promise.resolve(false)
    return isFile(binaryLocation())
  }

  function ensureInstalled(): Promise<void> | null {
    if (inFlight) return inFlight
    if (failed || !asset?.url || !deps.downloadEnabled()) return null
    if (existsSync(marker())) {
      failed = true
      logger.warn('the managed gh does not run on this machine; not downloading it', { version: deps.version })
      return null
    }
    const run = sweepStaging(deps.runtimesRoot())
      .then(install)
      .catch((error: unknown) => {
        failed = true
        logger.warn('could not install a managed gh; not retrying until the next start', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        inFlight = null
      })
    inFlight = run
    return run
  }

  async function binaryPath(): Promise<string | null> {
    if (!(await installed())) return null
    // In use: keep the tree out of another pin's sweep, which spares a week.
    if (now() - markedUsedAt >= MARK_USED_INTERVAL_MS) {
      markedUsedAt = now()
      await markUsed(root())
    }
    return binaryLocation()
  }

  return {
    /** Is there a pinned gh for this platform at all? */
    supported(): boolean {
      return Boolean(asset?.url)
    },

    /** The managed tree's root, installed or not. */
    root,

    /** Is the managed gh there? Its presence is the proof it was verified. */
    installed,

    /**
     * Where the managed `gh` is, or will be once it lands — without looking.
     * Synchronous, for a shell script that tests it with `-x`.
     */
    binaryLocation,

    /**
     * The managed `gh`'s path when it is installed, else null. Callers decide
     * whether a `gh` on PATH wins — this does not look. Never starts an install.
     */
    binaryPath,

    /**
     * Start the background install unless it is running, has failed in this
     * run, is switched off, or has nothing to install on this platform. Returns
     * the running install (for tests), or null when none was started. Never
     * rejects; callers do not await it.
     */
    ensureInstalled,

    /** True while an install started by {@link ensureInstalled} is running. */
    installing(): boolean {
      return inFlight !== null
    }
  }
}

export type ManagedGh = ReturnType<typeof createManagedGh>

function probeGhVersion(gh: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      gh,
      ['--version'],
      { env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' }, timeout: VERSION_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) resolve(null)
        else resolve(`${stdout}`.trim().split('\n')[0]?.trim() || null)
      }
    )
  })
}

export const managedGh = createManagedGh({
  platformKey: `${process.platform}-${process.arch}`,
  assets: RUNTIME_PINS.gh.assets,
  version: RUNTIME_PINS.gh.cli,
  versionOutput: RUNTIME_PINS.gh.versionOutput,
  // The engine resolver's `runtimesRootDir()`, restated as `managedGit.ts` does.
  runtimesRoot: () => join(runtimeHost.getPath('userData'), 'runtimes'),
  downloadEnabled: () => process.env['CINNA_GH_DOWNLOAD'] !== 'off',
  download: (url, dest, expectedBytes) => downloadToFile(url, dest, undefined, expectedBytes),
  extract: extractArchive,
  probeVersion: probeGhVersion
})
