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
import type { Dirent } from 'node:fs'
import { chmod, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
  sweepStaging,
  type DownloadProgress,
  type ManagedAssetErrorCode,
  type PinnedAsset
} from '../managed/managedAsset'
import { which } from '../shell/env'
import { PINNED_ENGINE_VERSION, type EngineBinarySource } from '../../shared/engine'
import { RUNTIME_PINS } from '../../shared/runtimePins'

const logger = createLogger('engine-binary')

const EXE = process.platform === 'win32' ? '.exe' : ''

/**
 * Everything that differs between the runtimes this module installs.
 *
 * The three sources, the staging, the digest check and the single-flight are
 * the same for every tool; what differs is a name, a URL, whether the user's
 * PATH counts, and the sentences a user reads when it fails. Those live here so
 * a second runtime is a second *spec*, not a second resolver — the invariant
 * worth having exactly one copy of is "nothing unverified is ever published".
 */
export interface RuntimeBinarySpec {
  /** Install directory prefix and single-flight key: `<root>/<tool>-<version>/`. */
  tool: string
  /** Log label, and the noun in {@link installPinnedAsset}'s own messages. */
  label: string
  /** The executable's name once installed. */
  binaryName: string
  /**
   * Whether a copy on the login-shell PATH is used before downloading.
   *
   * True for OpenCode: a developer's own install is a fine engine. False for
   * Codex, where the version under test has to be the version that runs — the
   * user's PATH copy stays what "Open in…" launches and nothing else.
   */
  searchPath: boolean
  url(version: string, asset: EngineAsset): string
  /**
   * The installed binary's `--version` output must satisfy this, or the install
   * is discarded before it is published. Absent means "any runnable version".
   */
  acceptsVersion?(probed: string | null, version: string): boolean
  messages: {
    unsupportedPlatform(key: string): string
    configuredMissing: string
    configuredUnusable: string
    archiveMissingBinary: string
    versionMismatch(version: string): string
  }
}

export const OPENCODE_SPEC: RuntimeBinarySpec = {
  tool: 'opencode',
  label: 'engine',
  binaryName: `opencode${EXE}`,
  searchPath: true,
  url: (version, asset) => asset.url ?? assetUrl(version, asset.file),
  messages: {
    // Remedy first, and short: this is the longest of the three and measured
    // 1039px problem-first, which clips at every window width.
    unsupportedPlatform: (key) =>
      `Install opencode yourself, or set the engine path in Settings: Cinna has no verified build for ${key}.`,
    // **Remedy first, because this sentence is measured to clip.** It lands
    // in the Runs-with panel's reserved line, which is 414px at the 800px
    // minimum; problem-first it needed 667px and lost the half that says
    // what to do (ux_rules rule 7). The Claude rung beside it leads with its
    // remedy for the same reason.
    configuredMissing: 'Fix the engine path in Settings, or clear it: it does not point at a file.',
    configuredUnusable: 'Fix the engine path in Settings, or clear it: that file will not run.',
    archiveMissingBinary: 'The downloaded engine archive did not contain an opencode executable.',
    versionMismatch: (version) => `The downloaded engine was not opencode ${version}, so it was discarded.`
  }
}

export const CODEX_SPEC: RuntimeBinarySpec = {
  tool: 'codex',
  label: 'Codex',
  binaryName: `codex${EXE}`,
  searchPath: false,
  url: (_version, asset) => {
    // Codex rows always carry their URL; a row without one is a manifest bug,
    // and guessing a URL for bytes whose digest is pinned helps nobody.
    if (!asset.url) throw new EngineBinaryError('unsupported_platform', 'The Codex pin has no download URL for this platform.')
    return asset.url
  },
  acceptsVersion: (probed, version) => probed === `codex-cli ${version}`,
  messages: {
    unsupportedPlatform: (key) =>
      `Set a Codex path in Settings → Local Development: Cinna has no verified Codex build for ${key}.`,
    configuredMissing: 'Fix the Codex path in Settings, or clear it: it does not point at a file.',
    configuredUnusable: 'Fix the Codex path in Settings, or clear it: that file will not run.',
    archiveMissingBinary: 'The downloaded Codex archive did not contain a codex executable.',
    versionMismatch: (version) => `The downloaded Codex was not version ${version}, so it was discarded. Try again.`
  }
}

/** Ceiling on the `--version` probe. A wedged binary must not wedge a start. */
const VERSION_TIMEOUT_MS = 10_000

/**
 * Re-exported so existing callers (and the tests) keep one import site for the
 * engine's download machinery, even though it is generic now.
 */
export { downloadToFile, extractArchive, sha256File }

/**
 * The engine's name for {@link PinnedAsset}; kept so callers read naturally.
 *
 * Widened with the two optional fields a pin-manifest row may carry: an
 * explicit download `url`, and the `executable` name inside the archive when it
 * is not the name the binary is installed under (Codex ships
 * `codex-<target triple>`).
 */
export type EngineAsset = PinnedAsset & { url?: string; executable?: string }

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
export const ENGINE_ASSETS: Readonly<Record<string, EngineAsset>> = RUNTIME_PINS.opencode.assets

/**
 * The pinned Codex CLI assets, from the same manifest. POSIX only — see
 * `shared/runtimePins.ts` for why the Windows release is not listed.
 */
export const CODEX_ASSETS: Readonly<Record<string, EngineAsset>> = RUNTIME_PINS.codex.assets

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
  /**
   * Which runtime this is. Optional, and OpenCode when absent, so the engine's
   * existing callers and tests are unchanged by the generalisation.
   */
  spec?: RuntimeBinarySpec
}

/**
 * Failure codes on top of {@link ManagedAssetErrorCode}: two about the path a
 * user typed into Settings rather than about a download, and one for a verified
 * archive whose binary then reported a version other than the pin.
 */
export type EngineBinaryErrorCode =
  | ManagedAssetErrorCode
  | 'configured_missing'
  | 'configured_unusable'
  | 'version_mismatch'

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
const installsInFlight = new Map<string, Promise<ResolvedEngineBinary>>()

/**
 * Where the running install reports its bytes. The most recent caller to ask
 * for progress wins, because a caller that *joins* an install did not create
 * the closure that is running — and a row stuck at 0% for a download that is
 * visibly happening is worse than no row. Same reasoning as the toolchain's
 * reporter slot.
 *
 * Keyed by tool, like the single-flight above: an OpenCode install and a Codex
 * install are different downloads and must neither join nor report for each
 * other.
 */
const installReports = new Map<string, DownloadProgress>()

function installPinned(
  deps: BinaryResolverDeps,
  onDownloadProgress?: DownloadProgress
): Promise<ResolvedEngineBinary> {
  const tool = (deps.spec ?? OPENCODE_SPEC).tool
  if (onDownloadProgress) installReports.set(tool, onDownloadProgress)
  const running = installsInFlight.get(tool)
  if (running) return running
  const run = runInstall(deps).finally(() => {
    if (installsInFlight.get(tool) === run) {
      installsInFlight.delete(tool)
      installReports.delete(tool)
    }
  })
  installsInFlight.set(tool, run)
  return run
}

/** `<root>/<tool>-<version>/<binary>` — where a managed install is, or will be. */
export function managedBinaryPath(deps: Pick<BinaryResolverDeps, 'engineRoot' | 'version' | 'spec'>): string {
  const spec = deps.spec ?? OPENCODE_SPEC
  return join(deps.engineRoot(), `${spec.tool}-${deps.version}`, spec.binaryName)
}

/**
 * After a **successful** install: remove this tool's other version directories
 * and any `.staging-*` no install in this process is using.
 *
 * Nothing else ever did. A pin bump left the previous ~90 MB (Codex) or ~46 MB
 * (OpenCode) tree in `userData` for good, and a download killed by a quit left
 * its staging directory beside it; only the toolchain's root was ever swept.
 *
 * Only on a fresh install, never on "already there": that is the one moment a
 * newer version is known to be good, and it keeps the everyday resolution at
 * one `stat`. Only **directories** named `<tool>-<digit>…`, so the OpenCode
 * root's own `opencode.json` and `prompts/` are not candidates. Best-effort
 * throughout: a tree that will not delete costs disk, while failing the
 * install over it would cost the user their runtime. A child still running the
 * old binary keeps its open file on POSIX; where that is refused (Windows) the
 * directory simply survives until the next install.
 */
async function sweepSuperseded(root: string, tool: string, keep: string): Promise<void> {
  const entries: Dirent[] = await readdir(root, { withFileTypes: true }).catch((): Dirent[] => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue
    if (!entry.name.startsWith(`${tool}-`) || !/^\d/.test(entry.name.slice(tool.length + 1))) continue
    await rm(join(root, entry.name), { recursive: true, force: true }).then(
      () => logger.info('removed a superseded runtime', { tool, directory: entry.name }),
      () => undefined
    )
  }
  await sweepStaging(root)
}

async function runInstall(deps: BinaryResolverDeps): Promise<ResolvedEngineBinary> {
  const spec = deps.spec ?? OPENCODE_SPEC
  const key = deps.platformKey()
  const asset = deps.assets[key]
  if (!asset) {
    throw new EngineBinaryError('unsupported_platform', spec.messages.unsupportedPlatform(key))
  }

  const root = deps.engineRoot()
  const installed = managedBinaryPath(deps)
  const installDir = dirname(installed)
  /** Set by `locate` when the version gate is what rejected the archive. */
  let rejectedVersion = false

  try {
    const { installed: didInstall } = await installPinnedAsset({
      root,
      installDir,
      label: spec.label,
      archiveName: asset.file,
      url: spec.url(deps.version, asset),
      sha256: asset.sha256,
      // The published directory is whichever one holds the binary, so
      // `<root>/<tool>-<version>/<binary>` is the path no matter how the
      // archive nested it — which keeps "is it installed" one `stat`, not a walk.
      locate: async (dir) => {
        const found = await findNamedFile(dir, asset.executable ?? spec.binaryName)
        if (!found) return null
        // An archive may name its executable after its target triple. It is
        // renamed *inside staging*, so what gets published has one name on
        // every platform and the install path never depends on the asset row.
        const target = join(dirname(found), spec.binaryName)
        if (found !== target) await rename(found, target)
        if (spec.acceptsVersion) {
          // Probed before the publishing rename: the digest proves these are
          // the pinned bytes, and this proves the pinned bytes are the version
          // the manifest says they are. A wrong answer publishes nothing.
          if (process.platform !== 'win32') await chmod(target, 0o755)
          if (!spec.acceptsVersion(await deps.probeVersion(target), deps.version)) {
            rejectedVersion = true
            return null
          }
        }
        return target
      },
      isInstalled: () => isFile(installed),
      onDownloadProgress: (received, total) => installReports.get(spec.tool)?.(received, total),
      download: deps.download,
      extract: deps.extract,
      notFoundMessage: spec.messages.archiveMissingBinary
    })
    if (didInstall) {
      logger.info('runtime installed', { tool: spec.tool, version: deps.version, platform: key })
      await sweepSuperseded(root, spec.tool, basename(installDir))
    }
  } catch (err) {
    if (rejectedVersion) {
      throw new EngineBinaryError('version_mismatch', spec.messages.versionMismatch(deps.version))
    }
    throw err
  }

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
  const spec = deps.spec ?? OPENCODE_SPEC
  const configured = deps.configuredPath()?.trim()
  if (configured) {
    // The sentences are the spec's (remedy first — see OPENCODE_SPEC for why).
    if (!(await isFile(configured))) {
      throw new EngineBinaryError('configured_missing', spec.messages.configuredMissing)
    }
    const version = await deps.probeVersion(configured)
    if (version === null) {
      throw new EngineBinaryError('configured_unusable', spec.messages.configuredUnusable)
    }
    // No version gate on a configured path, for either tool: "run the one I
    // told you to" is the whole point of the override, and the UI labels it
    // unverified rather than refusing it.
    return { path: configured, source: 'configured', version }
  }

  if (spec.searchPath) {
    const onPath = await deps.which(spec.tool)
    if (onPath) {
      const version = await deps.probeVersion(onPath)
      // A `which` hit that will not run is not fatal — fall through to the
      // managed copy rather than stranding the user on a broken install.
      if (version !== null) return { path: onPath, source: 'path', version }
      logger.warn('a runtime on PATH would not run; falling back to the managed copy', { tool: spec.tool })
    }
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

/* ------------------------------------------------------------------ Codex */

/**
 * Where managed CLI runtimes live: `<userData>/runtimes/<tool>-<version>/`.
 *
 * Not `engine/`, which stays OpenCode's: that directory's layout is what the
 * E2E engine cache copies in and out, and a second tool landing beside it would
 * change what "the engine directory" means to code that lists it.
 */
export function runtimesRootDir(): string {
  return join(app.getPath('userData'), 'runtimes')
}

/** The Codex path a user set in Settings, or null. Unpinned, shown as unverified. */
export function configuredCodexPath(): string | null {
  const value = appSettingsRepo.get('localAgentsCodexPath')
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * `CINNA_CODEX_DOWNLOAD=off` turns the download into a failure with a sentence.
 *
 * The E2E fixture sets it on every launch. A sandboxed test points the Codex
 * path at its scripted CLI, so nothing should ever reach this — and that is the
 * point: a spec that forgot to would otherwise pull 90 MB from the network
 * into a throwaway profile and then run the *real* CLI under a test's name.
 */
const codexDownload: BinaryResolverDeps['download'] = (url, dest, onProgress) => {
  if (process.env['CINNA_CODEX_DOWNLOAD'] === 'off') {
    return Promise.reject(
      new EngineBinaryError(
        'download_failed',
        'Set a Codex path in Settings: downloading the Codex CLI is switched off in this environment.'
      )
    )
  }
  return downloadToFile(url, dest, onProgress)
}

export function realCodexResolverDeps(configuredPath: () => string | null): BinaryResolverDeps {
  return {
    configuredPath,
    // Never consulted — `CODEX_SPEC.searchPath` is false — but the dep is not
    // optional, and wiring the real one keeps this object honest if that flips.
    which,
    engineRoot: runtimesRootDir,
    download: codexDownload,
    extract: extractArchive,
    probeVersion: probeEngineVersion,
    platformKey: () => `${process.platform}-${process.arch}`,
    assets: CODEX_ASSETS,
    version: RUNTIME_PINS.codex.cli,
    spec: CODEX_SPEC
  }
}

/**
 * The Codex binary a session would run **if nothing had to be downloaded**, or
 * null: the configured path when it is a file, else the managed copy when it is
 * already installed.
 *
 * For the callers that must never start a download — readiness, which runs for
 * a list, and the login probe, which runs on window focus. "Not here yet" is an
 * ordinary answer for them; fetching 90 MB to give a better one is not.
 */
export async function knownCodexBinary(): Promise<string | null> {
  const configured = configuredCodexPath()
  if (configured) return (await isFile(configured)) ? configured : null
  const managed = managedBinaryPath(realCodexResolverDeps(() => null))
  return (await isFile(managed)) ? managed : null
}
