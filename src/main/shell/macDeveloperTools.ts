/**
 * Apple's command line developer tools, and the stubs that stand in for them.
 *
 * On a Mac without the Command Line Tools (or Xcode), `/usr/bin/git`,
 * `/usr/bin/make`, `/usr/bin/python3`, `/usr/bin/clang` and the rest are not
 * the tools: they are one small `xcrun` shim, hard-linked under each name, whose
 * only job when the tools are absent is to pop the system "install the command
 * line developer tools" dialog. It pops **every time** anything execs one of
 * them. They are executable files on `PATH`, so `which()` — correctly, for the
 * terminal and "Open in…" — reports them as installed.
 *
 * This module answers the two questions that let the app never exec a stub:
 * is this path one of those stubs, and are the tools behind the stubs there.
 * `xcode-select -p` is the probe because it is not itself a stub and never pops
 * the dialog. Core module: no Electron import.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createLogger } from '../logger/logger'

const logger = createLogger('mac-developer-tools')

/**
 * Every name under `/usr/bin` that is the `xcrun` shim on macOS.
 *
 * Read off a real `/usr/bin` (macOS 15, 2025-11): exactly these 78 entries are
 * hard links of one 118,864-byte file. Anything not listed is either a real
 * system binary or not in `/usr/bin` at all.
 */
export const MAC_DEVELOPER_TOOL_STUBS: ReadonlySet<string> = new Set([
  'DeRez', 'GetFileInfo', 'ResMerger', 'Rez', 'SetFile', 'SplitForks',
  'ar', 'as', 'asa', 'bison', 'bm4', 'c++', 'c++filt', 'c89', 'c99', 'cc',
  'clang', 'clang++', 'clangd', 'cmpdylib', 'codesign_allocate', 'cpp', 'ctags',
  'ctf_insert', 'dsymutil', 'dwarfdump', 'dyld_info', 'flex', 'flex++', 'g++',
  'gatherheaderdoc', 'gcc', 'gcov', 'git', 'git-receive-pack', 'git-shell',
  'git-upload-archive', 'git-upload-pack', 'gm4', 'gnumake', 'gperf',
  'hdxml2manxml', 'headerdoc2html', 'indent', 'install_name_tool', 'ld', 'lex',
  'libtool', 'lipo', 'lldb', 'llvm-g++', 'llvm-gcc', 'lorder', 'm4', 'make',
  'mig', 'nm', 'nmedit', 'objdump', 'otool', 'pagestuff', 'pip3', 'python3',
  'ranlib', 'resolveLinks', 'rpcgen', 'segedit', 'size', 'sourcekit-lsp',
  'strings', 'strip', 'swift', 'swiftc', 'unifdef', 'unifdefall', 'vtool',
  'xml2man', 'yacc'
])

/** Where the stubs live. Only this directory; a Homebrew `git` is never a stub. */
const STUB_DIR = '/usr/bin'

/**
 * How long an answer stands. Short, so a user who runs `xcode-select --install`
 * while the app is open is picked up within a minute, without a restart.
 */
export const DEVELOPER_TOOLS_TTL_MS = 60_000

const PROBE_TIMEOUT_MS = 5_000

export interface MacDeveloperToolsDeps {
  platform: NodeJS.Platform
  /**
   * `xcode-select -p`: the active developer directory, or null when it exits
   * non-zero ("unable to get active developer directory" — the tools are
   * absent). Rejects when the probe itself failed — a timeout, a spawn error —
   * which says nothing about the tools.
   */
  developerDir: () => Promise<string | null>
  exists: (path: string) => boolean
  now: () => number
}

/**
 * `unknown`: `xcode-select` could not be run (timed out, failed to spawn) and
 * there is no earlier answer. Treated as absent for shimming, but never enough
 * to download a git onto a machine that may well have one.
 */
export type DeveloperToolsState = 'installed' | 'absent' | 'unknown'

const toState = (installed: boolean): DeveloperToolsState => (installed ? 'installed' : 'absent')

export function createMacDeveloperTools(deps: MacDeveloperToolsDeps) {
  let cached: { installed: boolean; at: number } | null = null
  let inFlight: Promise<DeveloperToolsState> | null = null
  /** Logged on change only; the probe repeats every TTL while an agent runs. */
  let lastLogged: boolean | null = null
  /** Bumped by `clear()`, so a probe spanning it does not cache its answer. */
  let generation = 0

  /** The answer, or null when the probe could not be run and so said nothing. */
  async function probe(): Promise<boolean | null> {
    let dir: string | null
    try {
      dir = await deps.developerDir()
    } catch (error) {
      logger.warn('could not ask xcode-select for the developer directory', { error: String(error) })
      return null
    }
    // A non-zero exit is the tools-absent answer.
    if (dir === null) return false
    dir = dir.trim()
    // Both Command Line Tools and Xcode.app put git under `<dir>/usr/bin`. A
    // developer directory that was selected and then deleted has none.
    return dir !== '' && deps.exists(join(dir, 'usr', 'bin', 'git'))
  }

  const api = {
    /** Is `path` the `/usr/bin` stub for a developer tool, on macOS? */
    isStub(path: string): boolean {
      return deps.platform === 'darwin' && dirname(path) === STUB_DIR && MAC_DEVELOPER_TOOL_STUBS.has(basename(path))
    },

    /**
     * What is known about the tools: `installed`, `absent`, or `unknown` — the
     * probe failed (a timeout, a spawn error) and there is no earlier answer to
     * stand on. Always `installed` off macOS, where there are no stubs. Never
     * pops the install dialog.
     */
    state(): Promise<DeveloperToolsState> {
      if (deps.platform !== 'darwin') return Promise.resolve('installed')
      if (cached && deps.now() - cached.at < DEVELOPER_TOOLS_TTL_MS) return Promise.resolve(toState(cached.installed))
      if (inFlight) return inFlight
      const startedAt = generation
      const run = probe()
        .then((answer): DeveloperToolsState => {
          if (answer === null) {
            // A failed probe is not an answer and is never cached as one. The
            // last real answer stands, for another TTL, so a hanging
            // xcode-select costs one timeout a minute rather than one per
            // caller. With none yet, `unknown` for this caller only, and the
            // next caller probes again.
            if (!cached) return 'unknown'
            if (startedAt === generation) cached = { installed: cached.installed, at: deps.now() }
            return toState(cached.installed)
          }
          const installed = answer
          if (installed !== lastLogged) {
            lastLogged = installed
            logger.info('Apple command line developer tools', { installed })
          }
          if (startedAt === generation) cached = { installed, at: deps.now() }
          return toState(installed)
        })
        .finally(() => {
          if (inFlight === run) inFlight = null
        })
      inFlight = run
      return run
    },

    /**
     * Are the tools behind the stubs installed? `unknown` reads as not —
     * shimming a working git costs an agent a git; a wrong "installed" costs
     * the user the dialog.
     */
    async installed(): Promise<boolean> {
      return (await api.state()) === 'installed'
    },

    /** Forget the answer, so the next caller probes again. */
    clear(): void {
      cached = null
      inFlight = null
      generation += 1
    }
  }
  return api
}

export type MacDeveloperTools = ReturnType<typeof createMacDeveloperTools>

export const macDeveloperTools = createMacDeveloperTools({
  platform: process.platform,
  developerDir: () =>
    new Promise((resolve, reject) => {
      execFile('/usr/bin/xcode-select', ['-p'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (!error) resolve(`${stdout}`)
        // A numeric code is the exit status of a process that ran to its end;
        // a timeout kills it (`killed`, signal, no code), and a spawn failure
        // carries an errno string such as ENOENT.
        else if (typeof error.code === 'number' && !error.killed) resolve(null)
        else reject(error)
      })
    }),
  exists: (path) => existsSync(path),
  now: () => Date.now()
})

/** `path` is a developer-tool stub on this Mac. */
export function isMacDeveloperToolStub(path: string): boolean {
  return macDeveloperTools.isStub(path)
}

/** The command line developer tools are installed (always true off macOS). */
export function macDeveloperToolsInstalled(): Promise<boolean> {
  return macDeveloperTools.installed()
}

/**
 * `which()`, minus the stubs: the resolved path, or — when it is a stub whose
 * tools are absent, so executing it would pop the install dialog — the next
 * match along `PATH` that is not a stub (a Homebrew git after `/usr/bin`).
 * Where that leaves nothing, `fallback` answers instead (the managed git's
 * wrapper, for `git`); `install` is false when the tools' state is unknown, so
 * a machine that may well have a git never downloads one.
 */
export function createUsableTool(deps: {
  which: (bin: string) => Promise<string | null>
  tools: Pick<MacDeveloperTools, 'isStub' | 'state'>
  /** The first match for `bin` along `PATH` that is not a stub, or null. */
  pastStub?: (bin: string) => Promise<string | null>
  fallback?: (bin: string, options: { install: boolean }) => Promise<string | null>
}): (bin: string) => Promise<string | null> {
  const fallback = deps.fallback ?? (async () => null)
  const pastStub = deps.pastStub ?? (async () => null)
  return async (bin) => {
    const found = await deps.which(bin)
    if (!found) return fallback(bin, { install: true })
    if (!deps.tools.isStub(found)) return found
    const state = await deps.tools.state()
    if (state === 'installed') return found
    const further = await pastStub(bin)
    if (further) return further
    return fallback(bin, { install: state !== 'unknown' })
  }
}
