/**
 * A `PATH` for engine children that cannot reach a macOS developer-tool stub.
 *
 * Claude Code, Codex and OpenCode run `git` (and whatever else a turn asks for)
 * themselves, at every session start. On a Mac without the command line
 * developer tools, the `git` they find is `/usr/bin/git` — the `xcrun` stub —
 * and every session start pops the system install dialog. Sessions start
 * lazily and are reaped when idle, so the dialog comes back again and again.
 *
 * The engine child gets a directory prepended to its `PATH` holding one tiny
 * script per stub name: it says the tool is not available and exits 127, which
 * is what the engines already handle as "command not found". Only names whose
 * lookup lands on the stub are shimmed, so a Homebrew `git` earlier on `PATH`
 * still wins. With the tools installed, nothing is prepended.
 *
 * With no usable git at all — the stub on such a Mac with no other `git`
 * further along `PATH`, or no `git` on a Linux `PATH` — the managed git
 * (`managedGit.ts`) stands in: once installed, its wrapper's own directory goes
 * first on `PATH`; until then the install is started in the background (not
 * when `xcode-select` could not be asked: the tools may be there) and the child
 * gets what it would have got without it.
 *
 * The `git` stand-in never leaves `tool-shims/` while `git` is a stub, and its
 * content never changes: it execs the managed git's wrapper when that exists
 * and says "not available" otherwise. A child started before the managed git
 * landed — a long-lived MCP server, whose `PATH` has `tool-shims/` but not
 * `git-shim/` — so reaches the managed git, never the `/usr/bin` stub. When a
 * real git sits further along `PATH`, there is no `git` stand-in: it would
 * shadow that git.
 *
 * Engine children only — never `getShellEnv()`, which the user's own terminal
 * also reads. Core module: paths come through the runtime host.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'
import { which, whichPastStub } from './env'
import { MAC_DEVELOPER_TOOL_STUBS, macDeveloperTools, type DeveloperToolsState } from './macDeveloperTools'
import { managedGit, shellQuote, type ManagedGit } from './managedGit'

const logger = createLogger('developer-tool-shims')

/** Under userData, beside nothing it could be confused with (`runtimes/`, `engine/`). */
export const SHIM_DIR_NAME = 'tool-shims'

/**
 * The stand-in for `name`. For `git` it is a resolver whose content never
 * changes, so a child that got it on its `PATH` never has it taken away: it
 * runs the first real `git` further along the caller's `PATH` (skipping Cinna's
 * own directories and the `/usr/bin` stub), else the managed git's wrapper when
 * it is there, else says git is not available. A real git installed while the
 * app runs, or the managed one landing, reaches a running child at once, and
 * nothing that child runs can reach the stub.
 */
export function shimScript(name: string, git?: { wrapper: string; ownDirs: readonly string[] }): string {
  // `name` comes from the fixed stub list, so it holds no quote or `$`.
  const lines = ['#!/bin/sh']
  if (git) {
    const skip = [...git.ownDirs.map(shellQuote), '/usr/bin', "''"].join('|')
    lines.push(
      'set -f; IFS=:',
      'for dir in $PATH; do',
      `  case "$dir" in ${skip}) continue ;; esac`,
      '  if [ -f "$dir/git" ] && [ -x "$dir/git" ]; then unset IFS; exec "$dir/git" "$@"; fi',
      'done',
      'unset IFS',
      `if [ -x ${shellQuote(git.wrapper)} ]; then exec ${shellQuote(git.wrapper)} "$@"; fi`
    )
  }
  lines.push(
    `echo "${name}: not available — Apple's command line developer tools are not installed (xcode-select --install)" >&2`,
    'exit 127'
  )
  return `${lines.join('\n')}\n`
}

export interface DeveloperToolShimDeps {
  platform: NodeJS.Platform
  toolsState: () => Promise<DeveloperToolsState>
  which: (bin: string) => Promise<string | null>
  /** The first match along `PATH` that is not a stub (a Homebrew git after `/usr/bin`). */
  whichPastStub: (bin: string) => Promise<string | null>
  isStub: (path: string) => boolean
  shimDir: () => string
  managedGit: Pick<ManagedGit, 'wrapperPath' | 'wrapperLocation' | 'ensureInstalled'>
}

export function createDeveloperToolShims(deps: DeveloperToolShimDeps) {
  /** Writes are serialised, so two plans starting at once never race a rename. */
  let queue: Promise<unknown> = Promise.resolve()

  /**
   * Make `dir` hold exactly one script per name in `names`, and nothing else a
   * `PATH` lookup could find. A shim left over for a tool the user has since
   * installed through Homebrew would otherwise shadow it.
   */
  async function sync(dir: string, names: readonly string[]): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o755 })
    const wanted = new Set(names)
    for (const name of names) {
      const path = join(dir, name)
      const wrapper = deps.managedGit.wrapperLocation()
      const content = shimScript(name, name === 'git' ? { wrapper, ownDirs: [dir, dirname(wrapper)] } : undefined)
      const current = await readFile(path, 'utf8').catch(() => null)
      if (current === content) {
        await chmod(path, 0o755)
        continue
      }
      const temp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
      await writeFile(temp, content, { mode: 0o755 })
      await chmod(temp, 0o755)
      await rename(temp, path)
    }
    for (const entry of await readdir(dir)) {
      if (entry.startsWith('.') || wanted.has(entry)) continue
      await rm(join(dir, entry), { force: true })
    }
  }

  /**
   * The directories to put first on `PATH`, in order: the managed git's
   * wrapper directory when git is missing and the managed git is installed,
   * then `tool-shims/` when there are stubs to stand in for.
   */
  async function plan(): Promise<string[]> {
    let names: string[] = []
    let gitMissing: boolean
    let mayInstall = true
    if (deps.platform === 'darwin') {
      const state = await deps.toolsState()
      if (state === 'installed') return []
      // Unknown: shim as for absent, but download nothing — there may be a git.
      mayInstall = state === 'absent'
      const found = await Promise.all(
        [...MAC_DEVELOPER_TOOL_STUBS].map(async (name) => {
          const path = await deps.which(name)
          return { name, path, stub: path !== null && deps.isStub(path) }
        })
      )
      names = found.filter((entry) => entry.stub).map((entry) => entry.name).sort()
      const git = found.find((entry) => entry.name === 'git')
      gitMissing = !git || git.path === null || git.stub
      if (git?.stub && (await deps.whichPastStub('git'))) {
        // A real git further along PATH: no managed git. The stand-in stays —
        // it runs that git, and a child whose PATH reaches the stub first
        // must keep it.
        gitMissing = false
      }
    } else {
      gitMissing = (await deps.which('git')) === null
    }
    const dirs: string[] = []
    if (gitMissing) {
      const wrapper = await deps.managedGit.wrapperPath()
      if (wrapper) dirs.push(dirname(wrapper))
      else if (mayInstall) void deps.managedGit.ensureInstalled()
    }
    if (names.length > 0) {
      const dir = deps.shimDir()
      const run = queue.then(() => sync(dir, names))
      queue = run.catch(() => undefined)
      await run
      dirs.push(dir)
    }
    return dirs
  }

  return {
    /**
     * `env` with the shim directories first on `PATH` when this is a Mac
     * without the developer tools or a machine using the managed git, else
     * `env` unchanged. Never throws: a shim that could not be written costs the
     * user the dialog (or a git), not the turn.
     */
    async apply<T extends Record<string, string | undefined>>(env: T): Promise<T> {
      if (deps.platform !== 'darwin' && deps.platform !== 'linux') return env
      try {
        const dirs = await plan()
        if (dirs.length === 0) return env
        // Drop earlier copies of either directory — a PATH that was already
        // shimmed, perhaps under the other plan — then put this plan first.
        const own = new Set([deps.shimDir(), ...dirs])
        const rest = (env.PATH ?? '').split(delimiter).filter((entry) => entry !== '' && !own.has(entry))
        return { ...env, PATH: [...dirs, ...rest].join(delimiter) } as T
      } catch (error) {
        logger.warn('could not shim the developer-tool stubs', { error: String(error) })
        return env
      }
    }
  }
}

const developerToolShims = createDeveloperToolShims({
  platform: process.platform,
  toolsState: () => macDeveloperTools.state(),
  which: (bin) => which(bin),
  whichPastStub: (bin) => whichPastStub(bin),
  isStub: (path) => macDeveloperTools.isStub(path),
  shimDir: () => join(runtimeHost.getPath('userData'), SHIM_DIR_NAME),
  managedGit
})

/**
 * The environment an engine child (Claude Code, Codex, OpenCode) runs in, with
 * the developer-tool stubs shadowed when the tools are absent and the managed
 * git in front when there is no other. Apply it last, to the env that also
 * feeds the launch spec's key, so installing the tools — or the managed git
 * landing — replaces a running child on its next turn: both change `PATH`.
 */
export function withDeveloperToolShims<T extends Record<string, string | undefined>>(env: T): Promise<T> {
  return developerToolShims.apply(env)
}
