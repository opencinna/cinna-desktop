/**
 * A git of Cinna's own, for a machine that has none.
 *
 * Engines run `git` at every session start, and the handover checks and the
 * agent-folder git view need it too. A Mac without Apple's command line
 * developer tools has only the `/usr/bin/git` stub (see `macDeveloperTools.ts`),
 * and a minimal Linux may have no git at all. On such a machine — and only
 * there — the app downloads GitHub Desktop's relocatable git
 * (`desktop/dugite-native`, pinned in `RUNTIME_PINS.git`) in the background and
 * runs it. A real git — Command Line Tools, Xcode, Homebrew, a distro package —
 * always wins; the managed one is then ignored, not deleted.
 *
 * ## Why a wrapper script
 *
 * The tree runs from anywhere only with the environment dugite itself sets
 * (`lib/git-environment.ts` in `desktop/dugite`): without `GIT_EXEC_PATH` https
 * fails ("'remote-https' is not a git command"), without `GIT_TEMPLATE_DIR`
 * every `init` warns. Those variables must never go into a child's environment
 * wholesale: a git the user installs later, run by that same child, would read
 * them too and break. So they live in a `#!/bin/sh` wrapper named `git`, in a
 * directory of its own (`<userData>/git-shim/`) that the developer-tool shims
 * put first on an engine child's `PATH`, and that `usableTool('git')` returns.
 *
 * A directory of its own, rather than a file in `tool-shims/`, because the
 * launch keys digest `PATH`: on a Mac the stand-in `git` already sits in
 * `tool-shims/`, and replacing its content would leave `PATH` — and so every
 * running session's key — identical. A new `PATH` entry is what lets the next
 * turn start a child that sees the git that just landed.
 *
 * ## When it downloads
 *
 * Never awaited by anything: {@link ManagedGit.ensureInstalled} starts at most
 * one install per app run, and after a failure does not try again until the
 * next run (a warning in the log, no UI). A tree that downloaded and verified
 * but will not run here — no `bin/git`, or the wrong `--version` answer — would
 * fail the same way on every start, so that failure leaves a marker,
 * `<runtimes>/.git-<version>-unsupported`, and this version is never downloaded
 * on this machine again; a new pin has a new marker name. A network or checksum
 * failure leaves none. `CINNA_GIT_DOWNLOAD=off` turns it off,
 * which the E2E fixture does on every launch. Core module: no Electron import.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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

const logger = createLogger('managed-git')

/** Under userData; holds exactly one file, the `git` wrapper. */
export const GIT_SHIM_DIR_NAME = 'git-shim'

const VERSION_TIMEOUT_MS = 10_000

/** How often a confirmed wrapper re-stamps the tree as used (`markUsed`); the sweep keeps a week. */
export const MARK_USED_INTERVAL_MS = 60 * 60 * 1000

/**
 * Beside the version directories in `runtimes/`, and dot-prefixed so neither
 * sweep (`.staging-*` directories, `git-<digit>…` directories) ever takes it.
 */
export function unsupportedMarkerName(version: string): string {
  return `.git-${version}-unsupported`
}

/** `value` as one POSIX shell word, whatever it holds. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * What dugite sets before it runs its git, for a tree at `root`. Keys whose
 * value is `{ unlessSet }` are only set when the caller's environment has none —
 * dugite leaves a user's own `GIT_CONFIG_SYSTEM` and `GIT_SSL_CAINFO` alone.
 */
export function managedGitEnv(
  root: string,
  platform: NodeJS.Platform
): Array<{ name: string; value: string; unlessSet?: boolean }> {
  const vars: Array<{ name: string; value: string; unlessSet?: boolean }> = [
    { name: 'GIT_EXEC_PATH', value: join(root, 'libexec', 'git-core') },
    // `/etc/gitconfig` is the system file on macOS and Linux and cannot be
    // ours; dugite points git at the tree's own defaults, which the user's
    // global and repository config still override.
    { name: 'GIT_CONFIG_SYSTEM', value: join(root, 'etc', 'gitconfig'), unlessSet: true },
    { name: 'GIT_TEMPLATE_DIR', value: join(root, 'share', 'git-core', 'templates') }
  ]
  if (platform === 'linux') {
    // A Linux build run from an arbitrary location resolves the rest of
    // itself from PREFIX, and uses its own CA bundle unless given one.
    // PREFIX is exported as dugite exports it: it reaches git's own children
    // (hooks, editors) too, and matching dugite is what this tree is tested under.
    vars.push({ name: 'PREFIX', value: root })
    vars.push({ name: 'GIT_SSL_CAINFO', value: join(root, 'ssl', 'cacert.pem'), unlessSet: true })
  }
  return vars
}

/** The `git` wrapper for a managed tree at `root`. */
export function gitWrapperScript(root: string, platform: NodeJS.Platform, version: string): string {
  const lines = ['#!/bin/sh', `# Cinna's managed git ${version} (dugite-native). Written by the app; do not edit.`]
  for (const { name, value, unlessSet } of managedGitEnv(root, platform)) {
    const assign = `${name}=${shellQuote(value)}; export ${name}`
    lines.push(unlessSet ? `if [ -z "\${${name}:-}" ]; then ${assign}; fi` : assign)
  }
  lines.push(`exec ${shellQuote(join(root, 'bin', 'git'))} "$@"`)
  return `${lines.join('\n')}\n`
}

/** Write `content` to `path` as an executable, atomically, unless it is already exactly that. */
async function publishScript(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === content) return
  const temp = join(dirname(path), `.git.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
  await writeFile(temp, content, { mode: 0o755 })
  await chmod(temp, 0o755)
  await rename(temp, path)
}

export interface ManagedGitDeps {
  platform: NodeJS.Platform
  /** `${platform}-${arch}`, the key into the pin table. */
  platformKey: string
  assets: Readonly<Record<string, RuntimePinAsset>>
  version: string
  /** Exactly what the pinned `git --version` prints. */
  versionOutput: string
  /** `<userData>/runtimes` — shared with the engine runtimes, and swept alike. */
  runtimesRoot: () => string
  /** `<userData>/git-shim`, where the wrapper lives. */
  shimDir: () => string
  /** False under `CINNA_GIT_DOWNLOAD=off`. */
  downloadEnabled: () => boolean
  /** Stream `url` to `dest`; `expectedBytes` is the pinned size, the download's ceiling. */
  download: (url: string, dest: string, expectedBytes?: number) => Promise<void>
  extract: (archive: string, dest: string) => Promise<void>
  /** First line of `<git> --version` run with `env` added, or null. */
  probeVersion: (git: string, env: Record<string, string>) => Promise<string | null>
  /** Clock for the `markUsed` throttle; `Date.now` unless a test drives it. */
  now?: () => number
}

export function createManagedGit(deps: ManagedGitDeps) {
  const asset = deps.assets[deps.platformKey]
  let inFlight: Promise<void> | null = null
  /** Set by a failed install: no second attempt in this run. */
  let failed = false
  /** When the wrapper last stamped the tree as used. */
  let markedUsedAt = Number.NEGATIVE_INFINITY
  const now = deps.now ?? Date.now

  const root = (): string => join(deps.runtimesRoot(), `git-${deps.version}`)
  const binary = (): string => join(root(), 'bin', 'git')
  const marker = (): string => join(deps.runtimesRoot(), unsupportedMarkerName(deps.version))
  const wrapperLocation = (): string => join(deps.shimDir(), 'git')

  async function install(): Promise<void> {
    if (!asset?.url) return
    const runtimes = deps.runtimesRoot()
    /** Why `locate` refused the verified tree, if it did: a failure that will recur. */
    let rejected: string | null = null
    const { installed: published } = await installPinnedAsset({
      root: runtimes,
      installDir: root(),
      label: 'git',
      archiveName: asset.file,
      url: asset.url,
      sha256: asset.sha256,
      // The tree root is the unpacked directory itself (`./bin/git`, `./libexec`).
      locate: async (unpacked) => {
        const git = join(unpacked, 'bin', 'git')
        if (!(await isFile(git))) {
          rejected = 'no bin/git in the archive'
          return null
        }
        // Run from staging with the same environment the wrapper will give it;
        // a tree that does not answer with the pin is never published.
        const env: Record<string, string> = {}
        for (const { name, value } of managedGitEnv(unpacked, deps.platform)) env[name] = value
        const answer = await deps.probeVersion(git, env)
        if (answer !== deps.versionOutput) {
          logger.warn('the downloaded git failed its version check', { answer })
          rejected = `version check answered ${JSON.stringify(answer)}`
          return null
        }
        return git
      },
      publishDir: (git) => dirname(dirname(git)),
      isInstalled: () => isFile(binary()),
      download: (url, dest) => deps.download(url, dest, asset.size),
      extract: deps.extract,
      notFoundMessage: `The downloaded git archive did not hold a bin/git that reports version ${deps.version}.`
    }).catch(async (error: unknown) => {
      if (rejected !== null) {
        await writeFile(marker(), `${rejected}\n`).catch((markError: unknown) =>
          logger.warn('could not record the managed git as unsupported', { error: String(markError) })
        )
      }
      throw error
    })
    if (published) {
      logger.info('installed a managed git', { version: deps.version })
      await sweepSuperseded(runtimes, 'git', `git-${deps.version}`)
    }
  }

  function installed(): Promise<boolean> {
    if (!asset) return Promise.resolve(false)
    return isFile(binary())
  }

  function ensureInstalled(): Promise<void> | null {
    if (inFlight) return inFlight
    if (failed || !asset?.url || !deps.downloadEnabled()) return null
    if (existsSync(marker())) {
      failed = true
      logger.warn('the managed git does not run on this machine; not downloading it', { version: deps.version })
      return null
    }
    const run = sweepStaging(deps.runtimesRoot())
      .then(install)
      .catch((error: unknown) => {
        failed = true
        logger.warn('could not install a managed git; not retrying until the next start', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        inFlight = null
      })
    inFlight = run
    return run
  }

  async function wrapperPath(): Promise<string | null> {
    if (!(await installed())) return null
    const path = wrapperLocation()
    await publishScript(path, gitWrapperScript(root(), deps.platform, deps.version))
    // In use: keep the tree out of another pin's sweep, which spares a week.
    if (now() - markedUsedAt >= MARK_USED_INTERVAL_MS) {
      markedUsedAt = now()
      await markUsed(root())
    }
    return path
  }

  return {
    /** Is there a pinned git for this platform at all? */
    supported(): boolean {
      return Boolean(asset?.url)
    },

    /** The managed tree's root, installed or not. */
    root,

    /** Is the managed tree there? Its presence is the proof it was verified. */
    installed,

    /**
     * Start the background install unless it is running, has failed in this
     * run, is switched off, or has nothing to install on this platform. Returns
     * the running install (for tests), or null when none was started. Never
     * rejects.
     */
    ensureInstalled,

    /**
     * The wrapper's path, written (or refreshed) first, when the managed tree
     * is installed; else null. Callers decide whether the system git is usable
     * — this does not look.
     */
    wrapperPath,

    /**
     * Where the wrapper is, or will be once the tree lands — without looking.
     * The macOS `git` stand-in delegates to it when it exists.
     */
    wrapperLocation,

    /**
     * For a caller that found no usable system git: the wrapper when the
     * managed git is installed, else null — and in that case the background
     * install is started, unless `install` is false (the developer tools'
     * state is unknown, so there may well be a git). Never throws.
     */
    async fallback(options: { install: boolean } = { install: true }): Promise<string | null> {
      try {
        const path = await wrapperPath()
        if (path) return path
      } catch (error) {
        logger.warn('could not write the managed git wrapper', { error: String(error) })
        return null
      }
      if (options.install) void ensureInstalled()
      return null
    }
  }
}

export type ManagedGit = ReturnType<typeof createManagedGit>

function probeGitVersion(git: string, env: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(git, ['--version'], { env: { ...process.env, ...env }, timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) resolve(null)
      else resolve(`${stdout}`.trim().split('\n')[0]?.trim() || null)
    })
  })
}

export const managedGit = createManagedGit({
  platform: process.platform,
  platformKey: `${process.platform}-${process.arch}`,
  assets: RUNTIME_PINS.git.assets,
  version: RUNTIME_PINS.git.cli,
  versionOutput: RUNTIME_PINS.git.versionOutput,
  // The engine resolver's `runtimesRootDir()`, restated: importing it would
  // pull the resolver and its settings store into the shell layer.
  runtimesRoot: () => join(runtimeHost.getPath('userData'), 'runtimes'),
  shimDir: () => join(runtimeHost.getPath('userData'), GIT_SHIM_DIR_NAME),
  downloadEnabled: () => process.env['CINNA_GIT_DOWNLOAD'] !== 'off',
  download: (url, dest, expectedBytes) => downloadToFile(url, dest, undefined, expectedBytes),
  extract: extractArchive,
  probeVersion: probeGitVersion
})
