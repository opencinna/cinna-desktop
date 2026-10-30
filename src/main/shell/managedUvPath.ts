/**
 * The desktop's managed uv as the last resort on a local-agent child's `PATH`.
 *
 * Kit agents run Python through `uv run` (`/run:` commands, schedules, the
 * clickable scripts in chat, and whatever an engine's own bash tool runs).
 * Cinna already downloads a pinned, SHA-verified uv for MCP servers and Local
 * Development (`localdev/toolchain.ts`); its directory is appended — never
 * prepended — to every such child's `PATH`, so a uv the user installed
 * themselves always wins and the managed one answers only when there is none.
 *
 * Appended whether or not the managed uv is installed yet: the path is known
 * in advance (`<userData>/localdev/uv-<pinned version>/`), a missing directory
 * costs nothing, and a long-lived engine process finds uv the moment the
 * pre-warm install lands. It is versioned, so moving the uv pin changes it
 * once (and with it an engine's env, which replaces a warm process).
 *
 * No `UV_CACHE_DIR`, `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR` or `UV_PYTHON_INSTALL_DIR`:
 * agent runs use uv's default directories, the ones a user-installed uv uses,
 * so a later `brew install uv` shares the cache and the Pythons, and the
 * toolchain's `uv-tools/` (the Cinna CLI) is never visible to agent code. The
 * one exception is `UV_PYTHON_PREFERENCE=only-managed`, set when no other uv
 * resolves (so the managed one will run) and the env does not already say:
 * on a Mac without the command line developer tools, uv probing
 * `/usr/bin/python3` raises the install dialog. A user's own uv keeps the
 * user's preference.
 *
 * Also the one place that recognises "uv could not start" in a finished
 * command, and the three sentences the user then reads.
 *
 * Core module: no Electron, and no import of `shell/env` (tests mock it
 * wholesale); the PATH walk is `pathWalk`'s.
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { managedUvLayout } from '../localdev/toolchain'
import { createLogger } from '../logger/logger'
import { findExecutable, splitPathEntries, type WalkPlatform } from './pathWalk'

const logger = createLogger('managed-uv-path')

export interface ManagedUvPathDeps {
  platform: NodeJS.Platform
  /** The directory holding the managed `uv`, installed or not. */
  uvDir: () => string
  isExecutable: (candidate: string) => Promise<boolean>
}

type Env = Record<string, string | undefined>

/** The env's `PATH` key: `Path` on a Windows env that spells it that way. */
function pathKey(env: Env, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

function walkPlatform(platform: NodeJS.Platform): WalkPlatform {
  return platform === 'win32' ? 'win32' : 'posix'
}

/** The first `bin` along `pathValue`, or null. */
export async function findOnPath(
  bin: string,
  pathValue: string | undefined,
  deps: Pick<ManagedUvPathDeps, 'platform' | 'isExecutable'>,
  pathExt?: string
): Promise<string | null> {
  const platform = walkPlatform(deps.platform)
  return findExecutable(bin, splitPathEntries(pathValue, platform), deps.isExecutable, { platform, pathExt })
}

export function createManagedUvPath(deps: ManagedUvPathDeps) {
  return {
    /**
     * `env` with the managed uv's directory last on `PATH`, and
     * `UV_PYTHON_PREFERENCE=only-managed` when no uv resolved before it.
     * Idempotent: an env that already ends with the directory comes back
     * unchanged. Never throws — a failure costs the fallback, not the run.
     */
    async apply<T extends Env>(env: T): Promise<T> {
      try {
        const dir = deps.uvDir()
        const key = pathKey(env, deps.platform)
        const delimiter = deps.platform === 'win32' ? ';' : ':'
        const entries = (env[key] ?? '').split(delimiter).filter((entry) => entry !== '')
        const rest = entries.filter((entry) => entry !== dir)
        if (entries.length > 0 && entries[entries.length - 1] === dir && rest.length === entries.length - 1) return env
        const restPath = rest.join(delimiter)
        const next: Env = { ...env, [key]: [...rest, dir].join(delimiter) }
        if (next.UV_PYTHON_PREFERENCE === undefined) {
          const pathExt = deps.platform === 'win32'
            ? env[Object.keys(env).find((name) => name.toUpperCase() === 'PATHEXT') ?? 'PATHEXT']
            : undefined
          const own = await findOnPath('uv', restPath, deps, pathExt)
          if (own === null) next.UV_PYTHON_PREFERENCE = 'only-managed'
        }
        return next as T
      } catch (error) {
        logger.warn('could not add the managed uv to PATH', { error: String(error) })
        return env
      }
    }
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate)
    if (!info.isFile()) return false
    if (process.platform === 'win32') return true
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const managedUvPath = createManagedUvPath({
  platform: process.platform,
  uvDir: () => dirname(managedUvLayout().uvBin),
  isExecutable: isExecutableFile
})

/**
 * The environment a local-agent child runs in: `env` with the managed uv as
 * the `PATH` fallback. Apply it after any `PATH` edit that prepends (the
 * developer-tool shims), so the managed directory stays last.
 */
export function withManagedUvFallback<T extends Env>(env: T): Promise<T> {
  return managedUvPath.apply(env)
}

/** The first `bin` on `env`'s `PATH` — what a child given `env` would run. */
export function resolveOnEnvPath(bin: string, env: Env): Promise<string | null> {
  const platform = process.platform
  return findOnPath(bin, env[pathKey(env, platform)], { platform, isExecutable: isExecutableFile }, env.PATHEXT)
}

/** What the pre-warm recorded when the managed uv could not be installed. */
export interface UvInstallFailure {
  code: string
  message: string
}

/** A shell saying `uv` is not there: sh/bash/dash (`uv: command not found`, `uv: not found`) and zsh (`command not found: uv`). */
const UV_NOT_FOUND = /\buv: (command )?not found\b|\bcommand not found: uv\b/

/**
 * Whether a finished local command failed because `uv` itself could not
 * start: the command is `uv …`, and either the shell said so on stderr
 * ("uv: not found" in any shell's words, or Windows' "is not recognized"), or
 * it exited 127 and no `uv` resolves on the child's PATH. Exit 127 alone is
 * not enough: `uv run` passes its child's exit code through, so a script whose
 * own tool is missing exits 127 too. `uvResolves` is only asked then.
 */
export async function uvCouldNotStart(
  command: string,
  outcome: { exitCode: number | null; stderr?: string | null },
  uvResolves: () => Promise<boolean>,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (!command.trimStart().startsWith('uv ')) return false
  const stderr = outcome.stderr ?? ''
  if (UV_NOT_FOUND.test(stderr)) return true
  if (platform === 'win32' && /\buv\b.*is not recognized/.test(stderr)) return true
  if (outcome.exitCode !== 127) return false
  return !(await uvResolves())
}

const UV_UNAVAILABLE = 'uv is not available, so this command could not start.'

/** The sentence a user reads when uv could not start, from the pre-warm's recorded failure. */
export function uvUnavailableMessage(failure?: UvInstallFailure | null): string {
  if (!failure) return `${UV_UNAVAILABLE} Cinna is still installing its copy; try again in a moment.`
  if (failure.code === 'unsupported_platform') {
    return `${UV_UNAVAILABLE} Cinna has no uv build for this platform; install uv (https://docs.astral.sh/uv/) and run it again.`
  }
  return `${UV_UNAVAILABLE} Cinna could not download its copy of uv (${failure.message}). Check the network connection and run it again.`
}
