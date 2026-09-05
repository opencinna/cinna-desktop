/**
 * The managed local-development toolchain: uv, Mutagen and cinna-cli.
 *
 * Everything the desktop needs in order to drive cinna-cli on the user's
 * machine, installed into `app.getPath('userData')/localdev/` and **nowhere
 * else**. Not Homebrew, not `~/.local/bin`, not the user's global Python. Two
 * reasons, and both matter more than the disk they cost:
 *
 * 1. A desktop app that mutates a developer's machine outside its own data
 *    directory is a support problem forever — a `brew install` that upgrades
 *    something else, a `pip install` into whatever `python3` happened to mean
 *    that day. Uninstalling Cinna should take the toolchain with it.
 * 2. The versions here are *pinned*, and a pin only means something if this app
 *    owns the file. A shared install is a version somebody else can move.
 *
 * Putting `cinna` on the user's shell PATH is a separate, explicit opt-in in
 * Settings (Phase C); nothing here writes to the shell profile.
 *
 * ## Layout
 *
 * ```
 * <userData>/localdev/
 *   uv-<uvVersion>/uv          the pinned uv, plus its uvx sibling
 *   mutagen-<mutagenVersion>/  the pinned mutagen, plus its agent bundle
 *   bin/                       UV_TOOL_BIN_DIR — `cinna` lands here
 *   uv-tools/                  UV_TOOL_DIR — the cinna-cli virtualenv
 *   python/                    UV_PYTHON_INSTALL_DIR — uv's own CPython
 *   uv-cache/                  UV_CACHE_DIR
 *   state.json                 what was installed, so a no-op ensure is cheap
 * ```
 *
 * Version-stamped directory names are what make an upgrade safe: a new pin
 * installs beside the old one and no running process has its binary swapped
 * underneath it. (Reaping the old directory is deliberately not done here —
 * knowing nothing is still using it is the reconciler's business, not the
 * installer's.)
 *
 * ## What is verified, and what is merely pinned
 *
 * uv and Mutagen are GitHub release assets, downloaded and checked against a
 * SHA-256 recorded below before anything is unpacked — the same mechanism, and
 * the same "the directory existing is the proof" invariant, as the OpenCode
 * engine. See `../managed/managedAsset.ts` for what that does and does not buy.
 *
 * cinna-cli is **not** hash-pinned. It is `uv tool install cinna-cli==<version>`
 * from PyPI, so the trust chain is TLS plus PyPI's own integrity, and a
 * compromised or yanked-and-replaced release would be installed. This is the
 * weakest link in this module and it is accepted knowingly: the alternatives
 * today are `--require-hashes` against a lock file the server would have to
 * publish and keep in step with `local_dev.cinna_cli_version`, or serving a
 * wheel from cinna-core itself. Both are real answers and both belong to a
 * later change; version-pinning over TLS is what ships now. Recorded here so
 * the next person weighing this finds the reasoning rather than an oversight.
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { ToolchainError } from '../errors'
import { createLogger } from '../logger/logger'
import {
  downloadToFile,
  extractArchive,
  findNamedFile,
  installPinnedAsset,
  isFile,
  ManagedAssetError,
  sweepStaging,
  type PinnedAsset
} from '../managed/managedAsset'
import { getShellEnv } from '../shell/env'

const logger = createLogger('localdev-toolchain')

/** Ceiling on a `--version` probe. A wedged binary must not wedge a reconcile. */
const PROBE_TIMEOUT_MS = 30_000

/**
 * Ceiling on `uv tool install`. Generous on purpose: on a cold profile this
 * downloads a CPython build *and* resolves and builds the cinna-cli dependency
 * tree, which on a slow connection is minutes rather than seconds.
 */
const INSTALL_TIMEOUT_MS = 15 * 60_000

/**
 * The uv version this desktop installs.
 *
 * uv is *ours* to pin — unlike Mutagen, nothing on the server has an opinion
 * about it — so a single version with a single digest table is the whole story.
 */
export const PINNED_UV_VERSION = '0.12.10'

/**
 * uv release assets, keyed `${process.platform}-${process.arch}`.
 *
 * The digests were computed by downloading each asset from the pinned release
 * and hashing it:
 *
 * ```
 * curl -sL https://github.com/astral-sh/uv/releases/download/0.12.10/uv-aarch64-apple-darwin.tar.gz | shasum -a 256
 * ```
 *
 * Each was then cross-checked against the `<asset>.sha256` file Astral publishes
 * beside it — which is a check on *our transfer*, not on the release: both come
 * from the same origin, so it catches a truncated download and nothing more.
 *
 * **Bumping {@link PINNED_UV_VERSION} means recomputing all four** — same rule
 * as `ENGINE_ASSETS`. A digest carried over from the previous version fails at
 * install time on every machine, which is at least loud; a *guessed* one would
 * be worse than no verification at all, because it would look like verification.
 *
 * Absent platforms are not a crash: they are a typed `unsupported_platform`
 * failure the UI explains. Windows is absent because the desktop does not build
 * for it yet (see `plans/one-click-onboarding-desktop.md` §1, non-goals), and
 * Linux uses the glibc builds — a musl-only distribution is the known gap,
 * exactly as for the engine.
 */
export const UV_ASSETS: Readonly<Record<string, PinnedAsset>> = {
  'darwin-arm64': {
    file: 'uv-aarch64-apple-darwin.tar.gz',
    sha256: '51c6170e8e3a01cef9f33b94f582b7b81ac65046f55d40afb35f9cff5a68c179'
  },
  'darwin-x64': {
    file: 'uv-x86_64-apple-darwin.tar.gz',
    sha256: '5296d5aa2b9143360405eea866f8ef4d5dc8986b164eb0dc35e8f876a9304d30'
  },
  'linux-x64': {
    file: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    sha256: '173d95a0c32d18c896c46ba6fafbf3cf9c14ab74b033f81b76c883ef492a976b'
  },
  'linux-arm64': {
    file: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    sha256: '9ff6b9d4665edcdd3a88dcc73cd1eb641754deb927f14e8c62ebfde6bf4f5f5e'
  }
}

/**
 * Mutagen release assets, keyed by **version** and then by
 * `${process.platform}-${process.arch}`.
 *
 * Mutagen's version is the one pin this desktop does not choose: it arrives
 * from the server as `local_dev.mutagen_version`, because the sync sessions it
 * runs have to interoperate with whatever cinna-core expects. The server pins
 * the *version*; this table pins the *bytes*.
 *
 * **A version absent from this table is a typed `unknown_mutagen_version`
 * failure, never an unverified download.** That is the deliberate trade, and it
 * has a visible cost: a server that bumps `MUTAGEN_VERSION` ahead of a desktop
 * release leaves those users with "update Cinna Desktop" until a build ships
 * with the new digests. The alternative — take the version and the URL from the
 * server and run whatever comes back — would make every verification in this
 * file decoration, since an attacker who can name the version can name the
 * bytes. Being occasionally behind is the cheaper failure.
 *
 * Digests computed the same way as {@link UV_ASSETS}:
 *
 * ```
 * curl -sL https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_darwin_arm64_v0.18.1.tar.gz | shasum -a 256
 * ```
 *
 * and cross-checked against the release's `SHA256SUMS` (which mutagen-io also
 * signs as `SHA256SUMS.gpg` — verifying that signature by hand before adding a
 * row is the strongest check available here, and worth doing).
 *
 * Adding a version means adding a whole platform row, not one entry: a row with
 * three of the four platforms filled in promises support that only one
 * architecture's users discover is missing.
 */
export const MUTAGEN_ASSETS: Readonly<
  Record<string, Readonly<Record<string, PinnedAsset>>>
> = {
  '0.18.1': {
    'darwin-arm64': {
      file: 'mutagen_darwin_arm64_v0.18.1.tar.gz',
      sha256: '6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2'
    },
    'darwin-x64': {
      file: 'mutagen_darwin_amd64_v0.18.1.tar.gz',
      sha256: '7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf'
    },
    'linux-x64': {
      file: 'mutagen_linux_amd64_v0.18.1.tar.gz',
      sha256: '7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f'
    },
    'linux-arm64': {
      file: 'mutagen_linux_arm64_v0.18.1.tar.gz',
      sha256: 'bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a'
    }
  }
}

export function uvAssetUrl(version: string, file: string): string {
  return `https://github.com/astral-sh/uv/releases/download/${version}/${file}`
}

export function mutagenAssetUrl(version: string, file: string): string {
  return `https://github.com/mutagen-io/mutagen/releases/download/v${version}/${file}`
}

/** The pins that come from the server's `/.well-known/cinna-desktop`. */
export interface ToolchainPins {
  cinnaCliVersion: string
  mutagenVersion: string
}

export interface ToolchainPaths {
  root: string
  binDir: string
  mutagenDir: string
  uvBin: string
  cinnaBin: string
}

/** `step` is user-visible copy; `percent` is a coarse hint, not a byte count. */
export type ToolchainProgress = (step: string, percent?: number) => void

export interface ToolchainResult {
  paths: ToolchainPaths
  cliVersion: string
}

/** What `state.json` remembers. Advisory: every field is re-checked on mismatch. */
interface ToolchainState {
  cinnaCliVersion?: string
}

export interface ToolchainDeps {
  /** `<userData>/localdev`. A function so nothing calls into Electron at import time. */
  root: () => string
  /** Key into the pin tables. Injected so a test can ask for any platform. */
  platformKey: () => string
  uvVersion: string
  /**
   * The pin tables, injected rather than read from the module constants, for
   * the same reason the engine injects its own: the failure worth testing is a
   * *mismatch*, and a test that cannot produce one is not testing verification.
   */
  uvAssets: Readonly<Record<string, PinnedAsset>>
  mutagenAssets: Readonly<Record<string, Readonly<Record<string, PinnedAsset>>>>
  download: (url: string, dest: string) => Promise<void>
  extract: (archive: string, dest: string) => Promise<void>
  /** The login-shell environment every spawned tool starts from. */
  shellEnv: () => Promise<NodeJS.ProcessEnv>
  /**
   * A local cinna-cli checkout to install `--editable` instead of the pinned
   * PyPI release, or null for the normal path.
   *
   * This exists for one situation, and it is a real one: the cross-repo
   * integration run has to exercise the cinna-cli that is being *developed*
   * alongside this app, which by definition is not on PyPI yet. Reading it from
   * the environment rather than from a setting keeps it out of the app's own
   * UI — there is no way for a user to turn this on by clicking something.
   */
  cliSourceOverride: () => string | null
  /** Run a binary to completion, capturing its output. */
  run: (
    bin: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>
}

export interface Toolchain {
  root(): string
  paths(pins: ToolchainPins): ToolchainPaths
  ensure(pins: ToolchainPins, onProgress?: ToolchainProgress): Promise<ToolchainResult>
  repair(pins: ToolchainPins, onProgress?: ToolchainProgress): Promise<ToolchainResult>
  toolchainEnv(pins: ToolchainPins): Promise<NodeJS.ProcessEnv>
}

/**
 * Translate a download/verify/unpack failure into the toolchain's own error.
 *
 * The codes are identical strings by design — `managedAsset` and this module
 * agree on what "checksum_mismatch" means — but the *type* differs so the
 * reconciler can catch one family, and the message names the tool, which the
 * generic installer cannot do as well as the caller can.
 */
function asToolchainError(err: unknown, label: string): ToolchainError {
  if (err instanceof ManagedAssetError) {
    // Every ManagedAssetErrorCode is also a ToolchainErrorCode; that overlap is
    // the point, so a reason does not change its name on the way up.
    return new ToolchainError(err.code, err.message, label)
  }
  if (err instanceof ToolchainError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new ToolchainError('download_failed', `Could not install ${label}: ${message}`, label)
}

/** First version-looking token in a `--version` line: "cinna, version 0.4.0" → "0.4.0". */
export function parseVersion(output: string): string | null {
  return /\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?/.exec(output)?.[0] ?? null
}

export function createToolchain(deps: ToolchainDeps): Toolchain {
  /**
   * In-flight installs, keyed by tool *and version*.
   *
   * This de-duplicates concurrent callers — two Cinna users activating at once
   * must not both unpack uv — and nothing more: entries are dropped when they
   * settle rather than memoised. A completed install is already cheap to
   * re-check (one `stat`, one small JSON read), and memoising the result would
   * make the app confidently wrong about a directory the user has since
   * deleted, which is exactly the state Repair exists to recover from.
   */
  const inFlight = new Map<string, Promise<unknown>>()

  function once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = inFlight.get(key) as Promise<T> | undefined
    if (running) return running
    const started = work().finally(() => {
      if (inFlight.get(key) === started) inFlight.delete(key)
    })
    inFlight.set(key, started)
    return started
  }

  function paths(pins: ToolchainPins): ToolchainPaths {
    const root = deps.root()
    return {
      root,
      binDir: join(root, 'bin'),
      mutagenDir: join(root, `mutagen-${pins.mutagenVersion}`),
      uvBin: join(root, `uv-${deps.uvVersion}`, 'uv'),
      cinnaBin: join(root, 'bin', 'cinna')
    }
  }

  function uvDirs(root: string): Record<string, string> {
    return {
      UV_TOOL_DIR: join(root, 'uv-tools'),
      UV_TOOL_BIN_DIR: join(root, 'bin'),
      UV_PYTHON_INSTALL_DIR: join(root, 'python'),
      UV_CACHE_DIR: join(root, 'uv-cache')
    }
  }

  /**
   * The environment for **every** process this toolchain spawns, uv included.
   *
   * `PATH` leads with the toolchain's own `bin/` and the pinned Mutagen
   * directory so that cinna-cli finds *our* Mutagen rather than the user's (or
   * none) — which is the whole reason its "Mutagen isn't installed, shall I
   * brew install it?" prompt never appears in a desktop-spawned run. The
   * login-shell PATH is appended last, not dropped: a user's `git`, `ssh` and
   * `docker` still have to resolve.
   *
   * The base is the user's full login-shell environment rather than the
   * narrowed `shellEnvForChild` allowlist used for MCP servers. The rule there
   * is about third-party programs whose configuration we did not write; here
   * every process is uv or our own CLI, and the strongest argument is symmetry
   * — `cinna` spawned by the desktop should behave exactly as it does when the
   * user runs it in their terminal, including their proxy settings, their CA
   * bundle and their locale. A discrepancy between those two would be a
   * miserable thing to debug.
   */
  async function toolchainEnv(pins: ToolchainPins): Promise<NodeJS.ProcessEnv> {
    const p = paths(pins)
    const base = await deps.shellEnv()
    const inherited = base.PATH ?? ''
    return {
      ...base,
      ...uvDirs(p.root),
      PATH: [p.binDir, p.mutagenDir, inherited].filter((entry) => entry !== '').join(delimiter)
    }
  }

  async function readState(root: string): Promise<ToolchainState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as ToolchainState) : {}
    } catch {
      // Absent, truncated by a crash, or hand-edited into nonsense — all three
      // mean the same thing: re-derive the truth from disk.
      return {}
    }
  }

  async function writeState(root: string, next: ToolchainState): Promise<void> {
    const current = await readState(root)
    await writeFile(join(root, 'state.json'), JSON.stringify({ ...current, ...next }, null, 2))
  }

  /**
   * Resolve both pin tables **before any work starts**.
   *
   * Deliberately up front rather than at each install: a server pinning a
   * Mutagen version this build has no digest for is a certainty, not an edge
   * case, and discovering it only after uv has been downloaded and unpacked
   * would spend a user's bandwidth on an install that cannot complete.
   */
  function requireAssets(pins: ToolchainPins): { uv: PinnedAsset; mutagen: PinnedAsset } {
    const key = deps.platformKey()
    const uv = deps.uvAssets[key]
    if (!uv) {
      throw new ToolchainError(
        'unsupported_platform',
        `Cinna has no verified uv build for ${key}, so local development cannot be set up on this machine.`,
        key
      )
    }
    const forVersion = deps.mutagenAssets[pins.mutagenVersion]
    if (!forVersion) {
      throw new ToolchainError(
        'unknown_mutagen_version',
        `This version of Cinna Desktop has no verified Mutagen ${pins.mutagenVersion}. Update Cinna Desktop to set up local development.`,
        pins.mutagenVersion
      )
    }
    const mutagen = forVersion[key]
    if (!mutagen) {
      throw new ToolchainError(
        'unsupported_platform',
        `Cinna has no verified Mutagen build for ${key}, so local development cannot be set up on this machine.`,
        key
      )
    }
    return { uv, mutagen }
  }

  async function ensureUv(
    pins: ToolchainPins,
    asset: PinnedAsset,
    onProgress?: ToolchainProgress
  ): Promise<void> {
    const p = paths(pins)
    if (await isFile(p.uvBin)) return
    onProgress?.('Installing uv', 10)
    try {
      await installPinnedAsset({
        root: p.root,
        installDir: join(p.root, `uv-${deps.uvVersion}`),
        label: 'uv',
        archiveName: asset.file,
        url: uvAssetUrl(deps.uvVersion, asset.file),
        sha256: asset.sha256,
        // uv's tarballs nest under `uv-<target>/`; publishing the directory that
        // holds `uv` also keeps its `uvx` sibling, which is free and correct.
        locate: (dir) => findNamedFile(dir, 'uv'),
        isInstalled: () => isFile(p.uvBin),
        download: deps.download,
        extract: deps.extract,
        notFoundMessage: 'The downloaded uv archive did not contain a uv executable.'
      })
    } catch (err) {
      throw asToolchainError(err, 'uv')
    }
  }

  async function ensureMutagen(
    pins: ToolchainPins,
    asset: PinnedAsset,
    onProgress?: ToolchainProgress
  ): Promise<void> {
    const p = paths(pins)
    const mutagenBin = join(p.mutagenDir, 'mutagen')
    if (await isFile(mutagenBin)) return
    onProgress?.('Installing Mutagen', 40)
    try {
      await installPinnedAsset({
        root: p.root,
        installDir: p.mutagenDir,
        label: 'Mutagen',
        archiveName: asset.file,
        url: mutagenAssetUrl(pins.mutagenVersion, asset.file),
        sha256: asset.sha256,
        // Mutagen's tarball is flat: `mutagen` beside `mutagen-agents.tar.gz`.
        // Publishing the whole directory is not incidental — mutagen refuses to
        // start a session without the agent bundle next to its binary.
        locate: (dir) => findNamedFile(dir, 'mutagen'),
        isInstalled: () => isFile(mutagenBin),
        download: deps.download,
        extract: deps.extract,
        notFoundMessage: 'The downloaded Mutagen archive did not contain a mutagen executable.'
      })
    } catch (err) {
      throw asToolchainError(err, 'Mutagen')
    }
  }

  /** `cinna --version`, or null when it is absent or will not run. */
  async function probeCli(pins: ToolchainPins): Promise<string | null> {
    const p = paths(pins)
    if (!(await isFile(p.cinnaBin))) return null
    const env = await toolchainEnv(pins)
    const result = await deps
      .run(p.cinnaBin, ['--version'], env, PROBE_TIMEOUT_MS)
      .catch(() => ({ code: null, stdout: '', stderr: '' }))
    if (result.code !== 0) return null
    return parseVersion(`${result.stdout}\n${result.stderr}`)
  }

  async function ensureCli(
    pins: ToolchainPins,
    reinstall: boolean,
    onProgress?: ToolchainProgress
  ): Promise<string> {
    const p = paths(pins)
    const source = deps.cliSourceOverride()

    // A local checkout is never "already installed": an editable install tracks
    // a working tree that changes under it, and the version it reports is
    // whatever that tree says — usually *not* the version the server pinned.
    // Skipping the install because a stamp matched would silently keep running
    // yesterday's checkout.
    if (!reinstall && !source) {
      // The cheap path, and the reason `state.json` exists at all: a reconcile
      // runs on every activation, on resume and after re-auth, and spawning a
      // Python entry point just to read a version number back is a visible
      // fraction of a second every time. The stamp is only ever *trusted to
      // skip work* — it is written after a verified install and re-derived by
      // an actual probe the moment it disagrees, so a stale or hand-edited file
      // costs one probe, never a wrong answer.
      const state = await readState(p.root)
      if (state.cinnaCliVersion === pins.cinnaCliVersion && (await isFile(p.cinnaBin))) {
        return state.cinnaCliVersion
      }
      // No stamp, or a stamp that disagrees. A `cinna` installed by an older
      // build of this app — or by a run that died before writing the stamp — is
      // perfectly good if it reports the pinned version; reinstalling it would
      // be minutes of downloading for nothing.
      const probed = await probeCli(pins)
      if (probed === pins.cinnaCliVersion) {
        await writeState(p.root, { cinnaCliVersion: probed })
        return probed
      }
    }

    onProgress?.('Installing cinna-cli', 70)
    const env = await toolchainEnv(pins)
    // `uv tool install` is idempotent for the same version and replaces a
    // different one, so the version change *is* the upgrade path; `--reinstall`
    // is only for Repair, where the install may be intact but broken.
    //
    // `--editable <path>` replaces the pin entirely when a source override is
    // set. That is a development affordance and it is loud about it: the
    // version pin, and with it the only thing resembling a supply-chain
    // guarantee for cinna-cli, does not apply to a working tree on this disk.
    const args = source
      ? ['tool', 'install', '--reinstall', '--editable', source]
      : [
          'tool',
          'install',
          ...(reinstall ? ['--reinstall'] : []),
          `cinna-cli==${pins.cinnaCliVersion}`
        ]
    if (source) {
      logger.warn('installing cinna-cli from a local checkout, ignoring the server pin', {
        source,
        pinned: pins.cinnaCliVersion
      })
    } else {
      logger.info('installing cinna-cli', { version: pins.cinnaCliVersion, reinstall })
    }
    const result = await deps.run(p.uvBin, args, env, INSTALL_TIMEOUT_MS).catch((err: unknown) => {
      throw new ToolchainError(
        'install_failed',
        'Could not run uv to install cinna-cli.',
        err instanceof Error ? err.message : String(err)
      )
    })
    if (result.code !== 0) {
      // The tail of stderr, not the whole of it: a uv resolver failure is
      // hundreds of lines and the last few are the ones that say why.
      throw new ToolchainError(
        'install_failed',
        `Installing cinna-cli ${pins.cinnaCliVersion} failed.`,
        result.stderr.trim().slice(-500) || `uv exited ${result.code}`
      )
    }

    const installed = await probeCli(pins)
    if (!installed) {
      throw new ToolchainError(
        'install_failed',
        'cinna-cli was installed but will not run.',
        p.cinnaBin
      )
    }
    // Not stamped for an editable install: the stamp's only job is to let a
    // later run skip the install, and a working tree is exactly the thing that
    // must not be skipped.
    if (!source) await writeState(p.root, { cinnaCliVersion: installed })
    logger.info('cinna-cli installed', { version: installed })
    return installed
  }

  async function run(
    pins: ToolchainPins,
    reinstall: boolean,
    onProgress?: ToolchainProgress
  ): Promise<ToolchainResult> {
    const p = paths(pins)
    const assets = requireAssets(pins)
    await mkdir(p.root, { recursive: true })
    // Once per pass, before any staging of our own: leftovers are from a
    // previous run that was killed, and sweeping per asset would race the
    // directory a sibling install is using right now.
    await sweepStaging(p.root)

    if (reinstall) {
      // Repair means "the files may be there and still wrong", so the proof of
      // a good install is deliberately destroyed before it is rebuilt. Removing
      // the install directories rather than the whole root keeps the uv cache
      // and the downloaded Python, which is the difference between a repair
      // that takes seconds and one that re-downloads a hundred megabytes.
      await rm(join(p.root, `uv-${deps.uvVersion}`), { recursive: true, force: true })
      await rm(p.mutagenDir, { recursive: true, force: true })
      await rm(join(p.root, 'state.json'), { force: true })
    }

    await once(`uv:${deps.uvVersion}:${reinstall}`, () => ensureUv(pins, assets.uv, onProgress))
    await once(`mutagen:${pins.mutagenVersion}:${reinstall}`, () =>
      ensureMutagen(pins, assets.mutagen, onProgress)
    )
    const cliVersion = await once(`cinna:${pins.cinnaCliVersion}:${reinstall}`, () =>
      ensureCli(pins, reinstall, onProgress)
    )
    return { paths: p, cliVersion }
  }

  return {
    root: deps.root,
    paths,
    ensure: (pins, onProgress) => run(pins, false, onProgress),
    repair: (pins, onProgress) => run(pins, true, onProgress),
    toolchainEnv
  }
}

/** `<userData>/localdev`. Never the agents home, never anywhere on the user's PATH. */
export function localDevRootDir(): string {
  return join(app.getPath('userData'), 'localdev')
}

/**
 * Run a binary to completion, capturing stdout and stderr.
 *
 * `spawn` rather than `exec`: nothing here is a shell command, and a version
 * string or a package name should never be at risk of being parsed as one.
 */
export function runCapture(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value: { code: number | null; stdout: string; stderr: string }): void => {
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
      finish({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) => finish({ code: null, stdout, stderr: `${stderr}${err.message}` }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}

export function realToolchainDeps(): ToolchainDeps {
  return {
    root: localDevRootDir,
    platformKey: () => `${process.platform}-${process.arch}`,
    uvVersion: PINNED_UV_VERSION,
    uvAssets: UV_ASSETS,
    mutagenAssets: MUTAGEN_ASSETS,
    download: downloadToFile,
    extract: extractArchive,
    shellEnv: getShellEnv,
    run: runCapture,
    cliSourceOverride: localCliSource
  }
}

/**
 * `CINNA_CLI_SOURCE`: a local cinna-cli checkout to install instead of the
 * pinned release.
 *
 * Set only by the cross-repo integration run (`make e2e-integration` passes it
 * through from `.env`), and never by anything a user can reach. A relative
 * value is refused rather than resolved: for a packaged app `process.cwd()` is
 * wherever the OS happened to launch it from, so a relative path here means
 * something different on every machine and is far more likely to be a mistake
 * than an intent.
 */
export function localCliSource(): string | null {
  const raw = (process.env['CINNA_CLI_SOURCE'] ?? '').trim()
  if (!raw) return null
  if (!isAbsolute(raw)) {
    logger.warn('ignoring CINNA_CLI_SOURCE: it must be an absolute path', {
      length: raw.length
    })
    return null
  }
  return raw
}

/** The process-wide toolchain. Phase C's reconciler is its only caller. */
export const toolchain: Toolchain = createToolchain(realToolchainDeps())
