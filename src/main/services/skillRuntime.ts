/**
 * The Python side skill scripts import on a desktop: `core.cinna_api`, the
 * stand-in for cinna-core's env-side package (catalog U11), shipped as
 * `resources/skill-runtime/core/cinna_api/`. A skill written for a cloud
 * agent does `from core.cinna_api import credentials, CredentialMissing` and
 * `credentials.require_slot("<service uri>")`; the shim reads the file
 * `CINNA_CREDENTIALS_PATH` names, which credential delivery writes.
 *
 * A copy of it goes first on `PYTHONPATH` for a kit agent's engine process,
 * whatever the engine (one hook in the ACP driver, where the credentials path
 * is set too), and for its kit commands and scheduled runs; a bare folder is
 * somebody's own repository and gets nothing. "Kit" is read as "carries
 * skills" (`prepare`'s `skillRuntime`): only a kit agent's DTO has `skills`.
 *
 * The copy, not the shipped folder: Python writes `__pycache__` beside a module
 * it imports, and the shipped folder sits inside the signed app bundle, which
 * must never change. So the runtime is copied once to
 * `<userData>/skill-runtime/<content hash>/` (staged beside it and swapped in,
 * like the `cinna-tasks` plugin) and rebuilt only when the shipped tree's hash
 * differs; development uses the same copy path.
 *
 * Core module: no Electron. Packaged it ships through `extraResources` as
 * `Resources/skill-runtime`; in development it is read from the repo, the
 * same rule as the bundled kit (`tasksSkillService`).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { delimiter, join, relative, sep } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { contractTreeHash } from '../kit/contractTreeHash'
import { swapInto } from '../kit/treeSwap'
import { createLogger } from '../logger/logger'

const logger = createLogger('skill-runtime')

/** Content hash of the copied tree, inside the copy: present only once the copy is complete. */
const RUNTIME_HASH_FILE = '.cinna-runtime-hash'

/** The shipped runtime: the folder that holds the `core` package. Read only; never put on `PYTHONPATH`. */
export function skillRuntimeSourceDir(): string {
  return runtimeHost.isPackaged
    ? join(runtimeHost.resourcesPath, 'skill-runtime')
    : join(runtimeHost.getAppPath(), 'resources', 'skill-runtime')
}

/** Where the copies live: `<userData>/skill-runtime/`. */
export function skillRuntimeCopiesDir(): string {
  return join(runtimeHost.getPath('userData'), 'skill-runtime')
}

/**
 * The writable copy of the runtime to put on `PYTHONPATH`, made when missing or
 * when the shipped tree changed, or null when it could not be made (logged; the
 * engine then runs without it rather than with the bundle on its path). Older
 * copies are removed once a new one is in place.
 */
export function ensureSkillRuntime(source: string = skillRuntimeSourceDir()): string | null {
  const root = skillRuntimeCopiesDir()
  let target = root
  try {
    const { hash } = contractTreeHash(source)
    target = join(root, hash.slice(0, 16))
    const hashFile = join(target, RUNTIME_HASH_FILE)
    if (existsSync(hashFile) && readFileSync(hashFile, 'utf8').trim() === hash) return target

    mkdirSync(root, { recursive: true })
    const staging = join(root, `.tmp-${process.pid}-${Date.now()}`)
    rmSync(staging, { recursive: true, force: true })
    cpSync(source, staging, { recursive: true, filter: (from) => !relative(source, from).split(sep).includes('__pycache__') })
    writeFileSync(join(staging, RUNTIME_HASH_FILE), `${hash}\n`)
    swapInto(staging, target)
    const entries: Dirent[] = readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name !== hash.slice(0, 16)) rmSync(join(root, entry.name), { recursive: true, force: true })
    }
    logger.info('skill runtime copied', { target, hash })
    return target
  } catch (error) {
    logger.warn('the skill runtime could not be copied', { target, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * `env` with `dir` prepended to `PYTHONPATH`, the existing value kept after
 * it (an agent's own path entries still resolve; a `core` package of its own
 * that comes later is shadowed by the shim). Never listed twice.
 */
export function withSkillRuntime(env: Record<string, string>, dir: string): Record<string, string> {
  const rest = (env.PYTHONPATH ?? '').split(delimiter).filter((entry) => entry !== '' && entry !== dir)
  return { ...env, PYTHONPATH: [dir, ...rest].join(delimiter) }
}

/**
 * A folder agent's engine env for one turn: `CINNA_CREDENTIALS_PATH` set to the file credential
 * delivery wrote (or removed when it wrote none), and for a kit agent (`skillRuntime`) the skill runtime on
 * `PYTHONPATH`, so its skill scripts find credentials by slot as they do in cinna-core. Every
 * engine (Claude, Codex, OpenCode) is launched with it and passes it to its tools' shell.
 */
export function engineCredentialEnv(
  base: Record<string, string>,
  prepared: { path?: string; skillRuntime: boolean },
  runtimeDir: () => string | null = ensureSkillRuntime
): Record<string, string> {
  const env = { ...base }
  delete env.CINNA_CREDENTIALS_PATH
  if (prepared.path) env.CINNA_CREDENTIALS_PATH = prepared.path
  const dir = prepared.skillRuntime ? runtimeDir() : null
  return dir ? withSkillRuntime(env, dir) : env
}
