/**
 * `CINNA_NODE` for engine children: an executable that runs a script the way
 * `node` does (`$CINNA_NODE <script>`), so the `cinna-dashboards` check script
 * can run a component's Node endpoint (`check_component.py --run`).
 *
 * The user's own `node` when one resolves on the `PATH` the engine gets;
 * otherwise a small shim the desktop writes under userData (`bin/cinna-node`,
 * a `.cmd` on Windows) around the host's own Node runtime
 * (`runtimeHost.nodeRuntime()`, Electron as Node on the desktop). The shim is
 * needed because the raw app binary opens a second copy of the app unless
 * `ELECTRON_RUN_AS_NODE=1` is set, and that variable must never be set in an
 * engine's own environment — so it lives inside the shim, for the one process
 * it starts. The contract never probes `CINNA_NODE` (`--version` or any flag):
 * it is run as `[CINNA_NODE, script]` only.
 *
 * The shim is rewritten only when its content differs, so its path (and with
 * it the engine env that feeds a launch key) is stable across turns.
 *
 * Core module: no Electron; the runtime comes through the runtime host.
 */

import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'
import { shellQuote } from './managedGit'
import { findOnPath } from './managedUvPath'

const logger = createLogger('cinna-node')

export const CINNA_NODE_ENV = 'CINNA_NODE'
/** Under userData; nothing else is put there. */
export const CINNA_NODE_BIN_DIR = 'bin'
export const CINNA_NODE_SHIM_NAME = 'cinna-node'

type Env = Record<string, string | undefined>

export interface CinnaNodeDeps {
  platform: NodeJS.Platform
  /** The host's own Node: command, leading args and the env it needs. */
  nodeRuntime: () => { command: string; args: string[]; env: Record<string, string> }
  /** Where the shim goes (`<userData>/bin`). */
  binDir: () => string
  isExecutable: (candidate: string) => Promise<boolean>
}

/** The `cmd.exe` form of one argument. */
function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * Taken from the environment the shim is run with, never written into it: the
 * extra CA file. Electron deletes `NODE_EXTRA_CA_CERTS` from a run-as-node
 * child (the NodeOptions fuse), so the shim hands the engine's value on as
 * `CINNA_EXTRA_CA_CERTS`, which the runtime's preload reads. The host's own
 * value of it in `runtime.env` is left out, so the shim's content (and the
 * launch keys built on its path) does not depend on it.
 */
const EXTRA_CA_ENV = 'CINNA_EXTRA_CA_CERTS'

/** The shim's file name and content on `platform`. */
export function cinnaNodeShim(platform: NodeJS.Platform, runtime: { command: string; args: string[]; env: Record<string, string> }): { name: string; content: string } {
  const names = Object.keys(runtime.env).filter((name) => name !== EXTRA_CA_ENV).sort()
  if (platform === 'win32') {
    const lines = ['@echo off', 'setlocal', `if defined NODE_EXTRA_CA_CERTS set "${EXTRA_CA_ENV}=%NODE_EXTRA_CA_CERTS%"`, ...names.map((name) => `set "${name}=${runtime.env[name]}"`), `${[runtime.command, ...runtime.args].map(cmdQuote).join(' ')} %*`]
    return { name: `${CINNA_NODE_SHIM_NAME}.cmd`, content: `${lines.join('\r\n')}\r\n` }
  }
  // Env names come from the host (`ELECTRON_RUN_AS_NODE`), never from user input.
  const assignments = `${EXTRA_CA_ENV}="\${NODE_EXTRA_CA_CERTS-}" ` + names.map((name) => `${name}=${shellQuote(runtime.env[name])} `).join('')
  const command = [runtime.command, ...runtime.args].map(shellQuote).join(' ')
  return { name: CINNA_NODE_SHIM_NAME, content: `#!/bin/sh\n${assignments}exec ${command} "$@"\n` }
}

function pathOf(env: Env, platform: NodeJS.Platform): { path: string | undefined; pathExt: string | undefined } {
  if (platform !== 'win32') return { path: env.PATH, pathExt: undefined }
  const key = (wanted: string): string => Object.keys(env).find((name) => name.toUpperCase() === wanted) ?? wanted
  return { path: env[key('PATH')], pathExt: env[key('PATHEXT')] }
}

export function createCinnaNode(deps: CinnaNodeDeps) {
  /** Writes are serialised, so two plans starting at once never race a rename. */
  let queue: Promise<unknown> = Promise.resolve()

  async function writeShim(): Promise<string> {
    const { name, content } = cinnaNodeShim(deps.platform, deps.nodeRuntime())
    const dir = deps.binDir()
    const target = join(dir, name)
    const current = await readFile(target, 'utf8').catch(() => null)
    if (current === content) {
      if (deps.platform !== 'win32') await chmod(target, 0o755)
      return target
    }
    await mkdir(dir, { recursive: true })
    const temp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temp, content, { mode: 0o755 })
    if (deps.platform !== 'win32') await chmod(temp, 0o755)
    await rename(temp, target)
    logger.info('cinna-node shim written', { target })
    return target
  }

  return {
    /** The shim's path, written or rewritten when its content differs. */
    ensureShim(): Promise<string> {
      const run = queue.then(writeShim)
      queue = run.catch(() => undefined)
      return run
    },

    /**
     * `env` with `CINNA_NODE` set: the first `node` on its `PATH`, else the
     * shim. Never adds `ELECTRON_RUN_AS_NODE`. Never throws — a shim that
     * could not be written costs the variable (the check then warns and skips
     * the run), not the turn.
     */
    async apply<T extends Env>(env: T): Promise<T> {
      try {
        const { path, pathExt } = pathOf(env, deps.platform)
        const own = await findOnPath('node', path, deps, pathExt)
        const value = own ?? (await this.ensureShim())
        return { ...env, [CINNA_NODE_ENV]: value }
      } catch (error) {
        logger.warn('could not set CINNA_NODE', { error: String(error) })
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

const cinnaNode = createCinnaNode({
  platform: process.platform,
  nodeRuntime: () => runtimeHost.nodeRuntime(),
  binDir: () => join(runtimeHost.getPath('userData'), CINNA_NODE_BIN_DIR),
  isExecutable: isExecutableFile
})

/**
 * An engine session's environment with `CINNA_NODE` set. Apply it last, after
 * the developer-tool shims and the managed uv, so the `node` it looks for is
 * the one the engine's own shell would find.
 */
export function withCinnaNode<T extends Env>(env: T): Promise<T> {
  return cinnaNode.apply(env)
}
