/**
 * The Python side skill scripts import on a desktop: `core.cinna_api`, the
 * stand-in for cinna-core's env-side package (catalog U11), shipped as
 * `resources/skill-runtime/core/cinna_api/`. A skill written for a cloud
 * agent does `from core.cinna_api import credentials, CredentialMissing` and
 * `credentials.require_slot("<service uri>")`; the shim reads the file
 * `CINNA_CREDENTIALS_PATH` names, which credential delivery writes.
 *
 * Its folder goes first on `PYTHONPATH` for a kit agent's engine process,
 * whatever the engine (one hook in the ACP driver, where the credentials path
 * is set too); a bare folder is somebody's own repository and gets nothing.
 * "Kit" is read as "carries skills" (`prepare`'s `skillRuntime`): only a kit
 * agent's DTO has `skills`.
 *
 * Core module: no Electron. Packaged it ships through `extraResources` as
 * `Resources/skill-runtime`; in development it is read from the repo, the
 * same rule as the bundled kit (`tasksSkillService`).
 */
import { delimiter, join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'

/** The folder that holds the `core` package: put on `PYTHONPATH`. */
export function skillRuntimeDir(): string {
  return runtimeHost.isPackaged
    ? join(runtimeHost.resourcesPath, 'skill-runtime')
    : join(runtimeHost.getAppPath(), 'resources', 'skill-runtime')
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
  runtimeDir: () => string = skillRuntimeDir
): Record<string, string> {
  const env = { ...base }
  delete env.CINNA_CREDENTIALS_PATH
  if (prepared.path) env.CINNA_CREDENTIALS_PATH = prepared.path
  return prepared.skillRuntime ? withSkillRuntime(env, runtimeDir()) : env
}
