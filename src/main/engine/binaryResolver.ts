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
import { createLogger } from '../logger/logger'
import {
  downloadToFile,
  extractArchive,
  findNamedFile,
  installPinnedAsset,
  isFile,
  ManagedAssetError,
  sha256File,
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
