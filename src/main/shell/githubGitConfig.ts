/**
 * The commit identity a kit agent's git gets from the OpenCinna GitHub sign-in (GitHub repos, G7b):
 * the user's noreply address (`<id>+<login>@users.noreply.github.com`) and their GitHub name, only
 * where git has no identity of its own, whatever the agent cloned with (`gh repo clone`, plain
 * `git clone`, a repository already on disk).
 *
 * A kit agent's child carries `GIT_CONFIG_GLOBAL=<userData>/github-identity/<profile>.gitconfig`,
 * a constant path per profile, so the engine process launched before the sign-in (the refused first
 * turn) and reused for the Continue turn sees the identity once it lands: main rewrites the files
 * on sign-in, sign-out and account change, never the env. The `.gitconfig` reads, in this order:
 *
 * 1. `includeIf "hasconfig:remote.*.url:<github.com pattern>"` → `<profile>.identity` (a `[user]`
 *    section while the profile is signed in, absent otherwise). Only a repository with a github.com
 *    remote (https, https with a user, scp-like ssh, ssh://) gets it; any other keeps git's normal
 *    behaviour.
 * 2. `include` → the user's own global files, as git would read them without the variable:
 *    `$XDG_CONFIG_HOME/git/config` (or `~/.config/git/config`), then `~/.gitconfig`, absolute
 *    paths from main's own view of HOME and XDG_CONFIG_HOME (the login shell's env), never a
 *    launch env's: engines narrow their env differently (Claude's has no XDG_CONFIG_HOME), and one
 *    file per profile must read the same for all of them. Later values win, so the user's own global identity beats
 *    ours; repository-local config, `-c` and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` beat global anyway.
 *    Missing files are ignored by git.
 *
 * Precedence is per key: a user global config with an email and no name gets our name with their
 * email. A remote written through a `url.<base>.insteadOf` shorthand (`gh:owner/repo`) does not
 * match: `hasconfig` sees the configured URL, not the rewritten one. A system-level identity (`/etc/gitconfig`) ranks below global in git, so ours beats it.
 * `hasconfig:remote.*.url` needs git 2.36; an older git ignores the condition and gets no identity
 * from here (Apple's git and the managed pin are newer).
 *
 * An agent's `git config --global x y` (a `safe.directory`, `gh auth setup-git`) now lands in this
 * file, not in the user's `~/.gitconfig`, which is never written. Main owns only the block between
 * {@link MANAGED_BEGIN} and {@link MANAGED_END} and rewrites only that (when it differs); whatever
 * git appended outside it is kept, and, coming after the includes, wins over the user's global
 * values. A key git adds inside an existing section of the block (`include.path`) is lost on the
 * next rewrite. A `GIT_CONFIG_GLOBAL` the user set themselves is left alone
 * (and then this mechanism is off). `gh` keeps its own `GH_CONFIG_DIR`; main's own git
 * (`gitService`, agent-folder commits) never gets this env.
 *
 * Core module: no Electron. The directory comes from the caller.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createLogger } from '../logger/logger'

const logger = createLogger('github-git-identity')

/** Under userData: one `<profile>.gitconfig` and `<profile>.identity` per profile. */
export const GITHUB_IDENTITY_DIR_NAME = 'github-identity'

/** The github.com remote URL patterns (git wildmatch, `/` not crossed by `*`) the identity applies to. */
export const GITHUB_REMOTE_PATTERNS = [
  'https://github.com/**',
  'https://*@github.com/**',
  'git@github.com:*/**',
  'ssh://git@github.com/**'
] as const

export interface GithubGitIdentity { name: string; email: string }

/** The managed block's first and last lines; everything outside them is the agent's own `--global` writes. */
export const MANAGED_BEGIN = '# >>> cinna-desktop managed block: rewritten by Cinna, do not edit >>>'
export const MANAGED_END = '# <<< cinna-desktop managed block <<<'

type Env = Record<string, string | undefined>

/** A profile id as a file name: kept when it is plain, else a hash of it. */
export function profileFileKey(userId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? userId : createHash('sha256').update(userId).digest('hex').slice(0, 32)
}

export function githubGitConfigPath(dir: string, userId: string): string {
  return join(dir, `${profileFileKey(userId)}.gitconfig`)
}
export function githubIdentityPath(dir: string, userId: string): string {
  return join(dir, `${profileFileKey(userId)}.identity`)
}

/** A `GIT_CONFIG_GLOBAL` this module set: `…/github-identity/<key>.gitconfig`, whatever the userData path. */
export function isOurGitConfig(value: string | undefined): boolean {
  return value !== undefined && new RegExp(`[/\\\\]${GITHUB_IDENTITY_DIR_NAME}[/\\\\][A-Za-z0-9_-]+\\.gitconfig$`).test(value)
}

/** A git config value in double quotes, or null for one git cannot hold (a newline, a NUL). */
function quoted(value: string): string | null {
  if (/[\n\r\0]/.test(value)) return null
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The `.gitconfig` for a child env: the identity include per github.com pattern, then the user's
 * own global files from the env's HOME / XDG_CONFIG_HOME. Null when a path cannot be written.
 */
export function githubGitConfigContent(identityPath: string, env: Env): string | null {
  const identity = quoted(identityPath)
  if (identity === null) return null
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : null
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? join(env.XDG_CONFIG_HOME, 'git', 'config') : home ? join(home, '.config', 'git', 'config') : null
  const own = [xdg, home ? join(home, '.gitconfig') : null].filter((p): p is string => p !== null).map(quoted)
  if (own.some((p) => p === null)) return null
  const lines = [
    MANAGED_BEGIN,
    '# The GitHub noreply identity where nothing else gives one, then your own global git config,',
    '# which wins. A `git config --global` an agent runs is added after this block and kept.'
  ]
  for (const pattern of GITHUB_REMOTE_PATTERNS) lines.push(`[includeIf "hasconfig:remote.*.url:${pattern}"]`, `\tpath = ${identity}`)
  if (own.length > 0) lines.push('[include]', ...own.map((p) => `\tpath = ${p}`))
  lines.push(MANAGED_END)
  return `${lines.join('\n')}\n`
}

/**
 * `current` (the file as it is, or null) with its managed block replaced by `block`, everything
 * outside it kept. A file without a whole block gets the block first and its content after it.
 */
export function withManagedBlock(current: string | null, block: string): string {
  if (current === null || current === '') return block
  const begin = current.indexOf(MANAGED_BEGIN)
  const end = begin === -1 ? -1 : current.indexOf(MANAGED_END, begin)
  if (begin === -1 || end === -1) return block + current
  let after = end + MANAGED_END.length
  if (current[after] === '\n') after++
  return current.slice(0, begin) + block + current.slice(after)
}

/** The `.identity` file's content, or null when the name or email cannot be written. */
export function githubIdentityContent(identity: GithubGitIdentity): string | null {
  const name = quoted(identity.name), email = quoted(identity.email)
  if (name === null || email === null) return null
  return `[user]\n\tname = ${name}\n\temail = ${email}\n`
}

/** Write `content` to `path` through a rename, only when it differs. */
function writeIfChanged(path: string, content: string): void {
  let current: string | null = null
  try { current = readFileSync(path, 'utf8') } catch { /* missing */ }
  if (current === content) return
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  renameSync(temp, path)
}

/**
 * The profile's `.gitconfig` with its managed block for `home` (main's own HOME and
 * XDG_CONFIG_HOME, never a launch env's), written when missing or when the block differs, what is
 * outside the block kept; its path, or null when it could not be written (logged).
 */
export function ensureGithubGitConfig(dir: string, userId: string, home: Env): string | null {
  const path = githubGitConfigPath(dir, userId)
  const block = githubGitConfigContent(githubIdentityPath(dir, userId), home)
  if (block === null) return null
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let current: string | null = null
    try { current = readFileSync(path, 'utf8') } catch { /* missing */ }
    writeIfChanged(path, withManagedBlock(current, block))
    return path
  } catch (error) {
    logger.warn('the GitHub git identity config could not be written', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/** The profile's `.identity`: the `[user]` section while signed in, removed when `identity` is null. Never throws. */
export function writeGithubIdentity(dir: string, userId: string, identity: GithubGitIdentity | null): void {
  const path = githubIdentityPath(dir, userId)
  try {
    const content = identity ? githubIdentityContent(identity) : null
    if (content === null) { rmSync(path, { force: true }); return }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeIfChanged(path, content)
  } catch (error) {
    logger.warn('the GitHub git identity could not be written', { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The ACP pool key's suffix for an env: `:github-identity:<profile>` only when its
 * `GIT_CONFIG_GLOBAL` is ours, so a warm process serves only turns held for the profile it was
 * launched for; empty for the user's own `GIT_CONFIG_GLOBAL` or none.
 */
export function githubIdentityKeySuffix(env: Env, profile: string | undefined): string {
  return profile && isOurGitConfig(env.GIT_CONFIG_GLOBAL) ? `:github-identity:${profile}` : ''
}

/** `env` without a `GIT_CONFIG_GLOBAL` of ours; the same object when there is none. */
export function withoutGithubGitConfig<T extends Env>(env: T): T {
  if (!isOurGitConfig(env.GIT_CONFIG_GLOBAL)) return env
  const next: Env = { ...env }
  delete next.GIT_CONFIG_GLOBAL
  return next as T
}

/** `env` with `GIT_CONFIG_GLOBAL` set to `path`, unless the env carries one the user set themselves. */
export function withGithubGitConfig<T extends Env>(env: T, path: string | null): T {
  const stripped = withoutGithubGitConfig(env)
  if (!path || stripped.GIT_CONFIG_GLOBAL !== undefined) return stripped
  return { ...stripped, GIT_CONFIG_GLOBAL: path }
}
