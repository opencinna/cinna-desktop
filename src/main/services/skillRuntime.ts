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
import { GH_ENDPOINT_BEARER_ENV, GH_ENDPOINT_URL_ENV, GH_SHIM_DIR_NAME, githubCredentialHelperFor } from '../shell/ghShim'
import { ensureGithubGitConfig, GITHUB_IDENTITY_DIR_NAME, githubGitConfigPath, withGithubGitConfig } from '../shell/githubGitConfig'
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
 *
 * With a Google record attached (`tokenEndpoint`), `CINNA_CREDENTIALS_TOKEN_URL` (the base the skill
 * runtime appends `/{id}/access-token` to) and `CINNA_CREDENTIALS_TOKEN` (the agent's bearer for it);
 * inherited values are always dropped first.
 *
 * For a kit agent (`githubEndpoint`), `CINNA_GITHUB_URL` (the `/github` base of the same listener) and
 * `CINNA_GITHUB_BEARER` (the same bearer), which Cinna's `gh` wrapper calls, plus the G4
 * `GIT_CONFIG_COUNT/KEY/VALUE` entries that point git's github.com credential helper at the wrapper
 * (after any entries the env already had). Without the endpoint, any of those entries of ours are
 * removed, so the child keeps the user's own keychain / GCM login. The bearer's name must not read
 * as a secret to an engine's env filter ({@link GH_ENDPOINT_BEARER_ENV}): the earlier
 * `CINNA_GITHUB_AUTH` was stripped from Claude's Bash under `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
 * (API Token mode), so gh and git fell back to the user's own login. An inherited value under
 * that old name is still dropped. The P0 probe pushed through `GIT_CONFIG_KEY_n` under Codex 0.167.0;
 * whether Codex passes `GIT_CONFIG_KEY_n` through the ACP adapter is still to be confirmed by a
 * live turn.
 *
 * With the endpoint's `identityProfile` (the profile the agent is held for when prepared),
 * `GIT_CONFIG_GLOBAL` names that profile's `<userData>/github-identity/<profile>.gitconfig`, which
 * gives git the OpenCinna noreply identity where it has none of its own (`githubGitConfig.ts`),
 * when that file exists (the prepare wrote it, {@link prepareGithubGitConfig}). Never over a
 * `GIT_CONFIG_GLOBAL` the user set; ours goes without the endpoint.
 */
export function engineCredentialEnv(
  base: Record<string, string>,
  prepared: { path?: string; skillRuntime: boolean; tokenEndpoint?: { url: string; token: string }; githubEndpoint?: GithubEndpoint },
  runtimeDir: () => string | null = ensureSkillRuntime,
  ghWrapper: () => string | null = ghWrapperPath,
  gitConfig: (userId: string) => string | null = githubGitConfigFor
): Record<string, string> {
  const env = { ...base }
  delete env.CINNA_CREDENTIALS_PATH
  delete env.CINNA_CREDENTIALS_TOKEN_URL
  delete env.CINNA_CREDENTIALS_TOKEN
  delete env[GH_ENDPOINT_URL_ENV]
  delete env[GH_ENDPOINT_BEARER_ENV]
  delete env.CINNA_GITHUB_AUTH
  if (prepared.path) env.CINNA_CREDENTIALS_PATH = prepared.path
  if (prepared.tokenEndpoint) { env.CINNA_CREDENTIALS_TOKEN_URL = prepared.tokenEndpoint.url; env.CINNA_CREDENTIALS_TOKEN = prepared.tokenEndpoint.token }
  if (prepared.githubEndpoint) { env[GH_ENDPOINT_URL_ENV] = prepared.githubEndpoint.url; env[GH_ENDPOINT_BEARER_ENV] = prepared.githubEndpoint.token }
  const dir = prepared.skillRuntime ? runtimeDir() : null
  const withRuntime = dir ? withSkillRuntime(env, dir) : env
  const profile = prepared.githubEndpoint?.identityProfile
  const withIdentity = withGithubGitConfig(withRuntime, profile ? gitConfig(profile) : null)
  return githubCredentialHelperFor(withIdentity, prepared.githubEndpoint ? ghWrapper() : null)
}

/**
 * A kit agent's GitHub endpoint: the loopback `/github` base, the agent's bearer, and the profile
 * whose commit identity its git gets (absent: none).
 */
export interface GithubEndpoint { url: string; token: string; identityProfile?: string }

/** `<userData>/github-identity/`. */
export function githubIdentityDir(): string {
  return join(runtimeHost.getPath('userData'), GITHUB_IDENTITY_DIR_NAME)
}

/** The profile's identity `.gitconfig` when it is on disk (macOS and Linux), else null. */
export function githubGitConfigFor(userId: string): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  const path = githubGitConfigPath(githubIdentityDir(), userId)
  return existsSync(path) ? path : null
}

/**
 * Write the profile's identity `.gitconfig` managed block for main's own HOME and XDG_CONFIG_HOME
 * (`home`: the login shell's env), the same for every engine and launch whatever each narrows its
 * env to. Called by a kit agent's prepare before {@link engineCredentialEnv}; nothing on Windows.
 */
export function prepareGithubGitConfig(userId: string, home: { HOME?: string; XDG_CONFIG_HOME?: string }): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  return ensureGithubGitConfig(githubIdentityDir(), userId, home)
}

/**
 * Cinna's `gh` wrapper when it is on disk (macOS and Linux; `withDeveloperToolShims` writes it
 * before the engine env reaches here), else null: a helper naming a missing file would break every
 * github.com remote.
 */
export function ghWrapperPath(): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  const path = join(runtimeHost.getPath('userData'), GH_SHIM_DIR_NAME, 'gh')
  return existsSync(path) ? path : null
}
