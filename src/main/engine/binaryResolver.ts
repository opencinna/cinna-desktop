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
 * The staging, verifying and atomic publishing itself now lives in
 * `../managed/managedAsset.ts`, because the local-dev toolchain installs uv and
 * Mutagen the same way and a second copy of that logic is a second place for
 * the "nothing partial is ever published" invariant to be got wrong. This
 * module keeps what is genuinely about *the engine*: the pin table, the three
 * sources and their precedence, and the `--version` probe. The guarantee is
 * unchanged — the presence of `<engine>/opencode-<version>/opencode` *is* the
 * proof that its bytes were checked.
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { appSettingsRepo } from '../db/appSettings'
import { createLogger } from '../logger/logger'
import {
  downloadToFile,
  extractArchive,
  findNamedFile,
  installPinnedAsset,
  isFile,
  ManagedAssetError,
  sha256File,
  type DownloadProgress,
  type ManagedAssetErrorCode,
  type PinnedAsset
} from '../managed/managedAsset'
import { which } from '../shell/env'
import { PINNED_ENGINE_VERSION, type EngineBinarySource } from '../../shared/engine'

const logger = createLogger('engine-binary')

/** Executable name, per platform. */
const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'

/** Ceiling on the `--version` probe. A wedged binary must not wedge a start. */
const VERSION_TIMEOUT_MS = 10_000

/**
 * Re-exported so existing callers (and the tests) keep one import site for the
 * engine's download machinery, even though it is generic now.
 */
export { downloadToFile, extractArchive, sha256File }

/** The engine's name for {@link PinnedAsset}; kept so callers read naturally. */
export type EngineAsset = PinnedAsset

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
  /**
   * Stream a URL to a file. Must not create the file unless bytes arrive.
   *
   * The third parameter is what {@link installPinnedAsset} has always passed;
   * it was simply not declared here while nothing in this module had anywhere
   * to put a byte count. Local development's pre-fetch row does.
   */
  download: (url: string, dest: string, onProgress?: DownloadProgress) => Promise<void>
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

/**
 * Two failure codes on top of {@link ManagedAssetErrorCode}, both about the
 * path a user typed into Settings rather than about a download.
 */
export type EngineBinaryErrorCode =
  | ManagedAssetErrorCode
  | 'configured_missing'
  | 'configured_unusable'

/**
 * Errors this module raises itself.
 *
 * The install path now throws {@link ManagedAssetError} directly — same `code`
 * strings, same messages, and `instanceof ManagedAssetError` catches both — so
 * anything branching on `err.code` is unaffected by the extraction.
 */
export class EngineBinaryError extends ManagedAssetError<EngineBinaryErrorCode> {}

/**
 * Install the pinned engine into `<engineRoot>/opencode-<version>/`, if it is
 * not already there.
 *
 * Concurrency and crash safety belong to {@link installPinnedAsset}: work
 * happens under a per-attempt staging directory and a single `rename`
 * publishes it, so a crash leaves junk no code path treats as an install and a
 * lost race keeps the winner. What is decided *here* is the engine's own part
 * — which asset this platform gets, where it is published, and how the binary
 * is found inside whatever shape the archive turned out to have.
 */
/**
 * The engine install currently running, so two callers share one download.
 *
 * There are genuinely two now: local development pre-fetches the binary, and
 * the engine resolves it again when a turn starts. Those overlap in the obvious
 * case — a user who sends a message while first-run setup is still going — and
 * again when a failed reconcile is retried while its engine download is still
 * in flight. {@link installPinnedAsset} makes a second download *safe* (the
 * loser's rename fails and the winner's tree is kept), but safe is not the
 * point: the pre-fetch exists to spend the bandwidth once, and spending it
 * twice at the moment the user is waiting is the whole failure.
 *
 * The entry is dropped when it settles rather than memoised, for the same
 * reason the toolchain drops its own: a remembered "already installed" would
 * make the app confidently wrong about a directory the user has since deleted.
 */
let installInFlight: Promise<ResolvedEngineBinary> | null = null

/**
 * Where the running install reports its bytes. The most recent caller to ask
 * for progress wins, because a caller that *joins* an install did not create
 * the closure that is running — and a row stuck at 0% for a download that is
 * visibly happening is worse than no row. Same reasoning as the toolchain's
 * reporter slot.
 */
let installReport: DownloadProgress | undefined

function installPinned(
  deps: BinaryResolverDeps,
  onDownloadProgress?: DownloadProgress
): Promise<ResolvedEngineBinary> {
  if (onDownloadProgress) installReport = onDownloadProgress
  if (installInFlight) return installInFlight
  const run = runInstall(deps).finally(() => {
    if (installInFlight === run) {
      installInFlight = null
      installReport = undefined
    }
  })
  installInFlight = run
  return run
}

async function runInstall(deps: BinaryResolverDeps): Promise<ResolvedEngineBinary> {
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

  const { installed: didInstall } = await installPinnedAsset({
    root,
    installDir,
    label: 'engine',
    archiveName: asset.file,
    url: assetUrl(deps.version, asset.file),
    sha256: asset.sha256,
    // The published directory is whichever one holds the binary, so
    // `<root>/opencode-<version>/opencode` is the path no matter how the
    // archive nested it — which keeps "is it installed" one `stat`, not a walk.
    locate: (dir) => findNamedFile(dir, BINARY_NAME),
    isInstalled: () => isFile(installed),
    onDownloadProgress: (received, total) => installReport?.(received, total),
    download: deps.download,
    extract: deps.extract,
    notFoundMessage: 'The downloaded engine archive did not contain an opencode executable.'
  })

  if (didInstall) logger.info('engine installed', { version: deps.version, platform: key })
  return { path: installed, source: 'managed', version: await deps.probeVersion(installed) }
}

/**
 * Resolve a binary through the three sources, in order.
 *
 * A configured path that is not a runnable file is an **error**, not a silent
 * fallback: the user pointed at something specific, and quietly running a
 * different engine than the one they named is worse than saying the path is
 * wrong.
 *
 * `onDownloadProgress` reports bytes only for the third source, and only when
 * it actually downloads. The first two resolve in milliseconds and have nothing
 * to report — a caller drawing a bar for this must be ready for it to be
 * answered instantly and never move, because the commonest good outcome is
 * "the user already has one".
 */
export async function resolveEngineBinaryWith(
  deps: BinaryResolverDeps,
  onDownloadProgress?: DownloadProgress
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

  return installPinned(deps, onDownloadProgress)
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

/** The engine's own directory inside the app data dir. Never the agents home. */
export function engineRootDir(): string {
  return join(app.getPath('userData'), 'engine')
}

/**
 * The engine path a user pinned in Settings, or null.
 *
 * Lives here rather than in the manager because two callers now need the same
 * answer — starting the engine, and pre-fetching its binary — and the setting
 * key is exactly the kind of string that gets copied once and then changed in
 * one place. The resolver core still takes the getter as an injected dep; this
 * is the app's own wiring of it, not a shortcut past it.
 */
export function configuredEnginePath(): string | null {
  const value = appSettingsRepo.get('localAgentsEnginePath')
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Make sure a usable engine binary is on this machine, without starting one.
 *
 * Left alone, the engine arrives *lazily* — at the moment somebody presses send
 * — which is the worst time for a 46 MB download and the one time the user is
 * certainly watching. Local development calls this so the fetch happens inside
 * a wait that is already going on. Nothing else changes: the three sources are
 * unchanged and in the same order, so a configured path or a developer's own
 * `opencode` answers instantly and downloads nothing. Pre-caching must never
 * mean acquiring a second copy of a tool the user already installed.
 *
 * **Never throws.** This is an optimisation; a machine that cannot fetch the
 * engine now fetches it at first use exactly as it did before this existed, and
 * the caller's job is to say so rather than to fail whatever it was doing.
 */
export async function prefetchEngineBinary(
  onDownloadProgress?: DownloadProgress
): Promise<{ ok: true; source: EngineBinarySource } | { ok: false; error: string }> {
  try {
    const resolved = await resolveEngineBinaryWith(
      realBinaryResolverDeps(configuredEnginePath),
      onDownloadProgress
    )
    return { ok: true, source: resolved.source }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn('engine prefetch failed; the first turn will fetch it', { error })
    return { ok: false, error }
  }
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
