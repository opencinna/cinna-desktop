/**
 * Keeping an agents folder up to date with the repository it came from.
 *
 * A folder of agents is very often a git working tree that somebody else also
 * writes to — the shape this was built for is a team repository of agents,
 * cloned once and then quietly left behind. This is the smallest thing that
 * fixes that: say whether a root is a repository, say whether it is behind,
 * show what the missing commits are, and fast-forward.
 *
 * ## What it deliberately will not do
 *
 * **It never resolves a conflict, and never tries.** No merge, no rebase, no
 * stash, no `--force`, no commit, no push. The only update it performs is
 * `merge --ff-only`, which by construction either replays the remote's commits
 * onto an unchanged tree or refuses and changes nothing.
 *
 * That is not caution for its own sake. A desktop that resolves a conflict on a
 * user's behalf has to decide which of two people's work survives, in a
 * repository it knows nothing about, with the answer landing in files an agent
 * will then be run from. Every state this cannot handle — local changes, local
 * commits, a diverged history, no upstream — is reported as a *reason*, in the
 * user's words, with the suggestion to sort it out in their own tools or ask an
 * agent in that folder to do it. Refusing legibly is the feature.
 *
 * ## Why the subprocess is shaped the way it is
 *
 * - `execFile`, never a shell: a repository path can contain anything, and
 *   there is no interpolation into a command string anywhere here.
 * - Every invocation is bounded by a timeout. `fetch` reaches the network and
 *   gets a long one; everything else is local and gets a short one.
 * - `git` is resolved through the login-shell `PATH`, because a GUI-launched
 *   app on macOS inherits launchd's bare one and would report "git is not
 *   installed" on a machine where it plainly is.
 * - The child gets the **narrowed** child environment, which keeps
 *   `SSH_AUTH_SOCK` (so a private repo over SSH still authenticates through the
 *   user's agent) without handing a subprocess the whole shell profile.
 * - `GIT_TERMINAL_PROMPT=0` and a batch-mode `GIT_SSH_COMMAND`: a fetch that
 *   wants a password or a host-key confirmation has no terminal to ask on, and
 *   would otherwise hang until the timeout with nothing on screen.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import type {
  GitCommit,
  GitDetail,
  GitRefusal,
  GitRemote,
  GitStatus,
  GitUpdateResult
} from '../../../shared/agentGit'
import type { AgentShareState, ShareRefusal } from '../../../shared/agentSharing'
import { MANIFEST_FILE } from '../../../shared/kit/manifest'
import { getLayout, getLayoutView, getTemplateRoot } from '../../kit/contractStore'
import { isSecretFile } from '../../kit/validator'
import { getShellEnv, shellEnvForChild, usableTool } from '../../shell/env'
import { createLogger } from '../../logger/logger'

const logger = createLogger('local-agent-git')

/** Local operations: reading refs and the index. Generous, but bounded. */
const LOCAL_TIMEOUT_MS = 20_000

/** `fetch` reaches the network. Long enough for a slow clone, not forever. */
const NETWORK_TIMEOUT_MS = 120_000

/** Most commits listed for one update. A list, not a changelog. */
const MAX_COMMITS = 50

/** How far up {@link looksLikeGitRepo} walks looking for a `.git` entry. */
const GIT_ANCESTOR_DEPTH = 8

/** Cap on any one command's output, so a pathological repo cannot exhaust us. */
const MAX_BUFFER = 4 * 1024 * 1024

const NOT_A_REPO: GitStatus = {
  isRepo: false,
  repoRoot: null,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  dirty: false,
  incoming: [],
  refusal: 'not_a_repo',
  fetched: false
}

/**
 * A cheap, synchronous "is this inside a git working tree?".
 *
 * Stats for a `.git` entry at the folder and each ancestor. No subprocess, so
 * it can be answered for every registered root on every `roots-list` — which is
 * the point: whether the update panel exists at all has to be known at **first
 * paint**, or the panel appears a moment later and pushes the settings rows
 * below it down, which is a control moving under a pointer (ux_rules rule 1).
 *
 * `.git` is a directory in a normal clone and a *file* in a worktree or
 * submodule, so the entry's type is deliberately not checked. The walk is
 * bounded because an unbounded one on a deep path is a lot of stats for an
 * answer that is wrong anyway by then.
 *
 * This is an approximation and {@link readGitStatus} remains the authority: it
 * only decides whether to *ask*. A false positive costs one `rev-parse` that
 * answers `not_a_repo` and renders nothing.
 */
export function looksLikeGitRepo(dir: string): boolean {
  let current = dir
  for (let depth = 0; depth <= GIT_ANCESTOR_DEPTH; depth += 1) {
    try {
      statSync(join(current, '.git'))
      return true
    } catch {
      /* keep walking up */
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
  return false
}

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Run one git command in `cwd`.
 *
 * Never throws and never rejects: a non-zero exit is an *answer* here — "this
 * is not a repository", "there is no upstream" — and a caller that had to
 * try/catch each of a dozen probes would end up treating a real failure and an
 * expected one the same way.
 */
async function run(
  gitPath: string,
  cwd: string,
  args: string[],
  timeout: number,
  /**
   * Added last, so it wins. Only the sharing verbs use it, for the
   * `GIT_CONFIG_*` variables that carry a Cinna token (see {@link authEnv}) —
   * the one way a credential reaches a git child without being in its argv,
   * where any process listing shows it, or in `.git/config`, where it outlives
   * the operation.
   */
  extraEnv: Record<string, string> = {}
): Promise<RunResult> {
  const shellEnv = await getShellEnv()
  const env = {
    ...shellEnvForChild(shellEnv),
    // Nothing here has a terminal. Without these a fetch needing a password or
    // a host-key confirmation blocks until the 120s timeout with no sign of why.
    //
    // `accept-new` is **trust on first use**, and that is a decision rather
    // than a default: a host key never seen before is accepted without a
    // prompt. The alternative, `ask`, has nowhere to ask — it would hang until
    // the timeout on a question the user cannot answer and cannot see. What it
    // does *not* do is the dangerous half: a key that has changed since it was
    // recorded is still refused, so the case this waives is the first contact,
    // not an impersonation of a host already known.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    // Porcelain output in a stable language, whatever the user's locale is.
    LC_ALL: 'C',
    ...extraEnv
  }
  return new Promise<RunResult>((resolve) => {
    execFile(
      gitPath,
      args,
      { cwd, timeout, maxBuffer: MAX_BUFFER, env, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: err === null,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : ''
        })
      }
    )
  })
}

/**
 * `<hash>\x1f<subject>\x1f<author>\x1f<iso date>` per line.
 *
 * Unit separator rather than a printable delimiter: a commit subject can
 * contain anything, and `|` or a tab in a subject would split a row into the
 * wrong number of fields — which shows up as a commit attributed to the wrong
 * person rather than as an error.
 */
const LOG_FORMAT = '--pretty=format:%h\x1f%s\x1f%an\x1f%aI'

function parseCommits(stdout: string): GitCommit[] {
  const out: GitCommit[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const [hash, subject, author, date] = line.split('\x1f')
    if (!hash) continue
    out.push({
      hash,
      subject: subject ?? '',
      author: author ?? '',
      date: date ?? ''
    })
  }
  return out
}

/**
 * Null for a macOS `/usr/bin/git` stub with no developer tools behind it:
 * running it pops the install dialog, so it reads as "git is not installed".
 */
async function resolveGit(): Promise<string | null> {
  return usableTool('git')
}

/**
 * Read a folder's repository state, optionally fetching first.
 *
 * `fetch` is a parameter rather than always-on because this is called for every
 * root the settings screen renders: a network round trip per root on every
 * open would make the screen slow for a feature the user has not asked to use
 * yet. The counts are then "as of the last fetch", which the panel says.
 */
export async function readGitStatus(dir: string, fetch = false): Promise<GitStatus> {
  const gitPath = await resolveGit()
  if (!gitPath) return { ...NOT_A_REPO, refusal: 'git_missing' }

  const top = await run(gitPath, dir, ['rev-parse', '--show-toplevel'], LOCAL_TIMEOUT_MS)
  if (!top.ok) return { ...NOT_A_REPO }
  const repoRoot = top.stdout.trim()
  if (repoRoot === '') return { ...NOT_A_REPO }

  const base: GitStatus = {
    ...NOT_A_REPO,
    isRepo: true,
    repoRoot,
    refusal: null
  }

  const branchOut = await run(
    gitPath,
    repoRoot,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    LOCAL_TIMEOUT_MS
  )
  const branch = branchOut.ok ? branchOut.stdout.trim() : ''
  base.branch = branch === '' || branch === 'HEAD' ? null : branch

  let fetched = false
  if (fetch) {
    const result = await run(gitPath, repoRoot, ['fetch', '--quiet'], NETWORK_TIMEOUT_MS)
    fetched = result.ok
    if (!result.ok) {
      logger.warn('git fetch failed', { stderr: result.stderr.slice(0, 400) })
      return { ...base, fetched: false, refusal: 'fetch_failed' }
    }
  }
  base.fetched = fetched

  const upstreamOut = await run(
    gitPath,
    repoRoot,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    LOCAL_TIMEOUT_MS
  )
  if (!upstreamOut.ok || upstreamOut.stdout.trim() === '') {
    return { ...base, refusal: 'no_upstream' }
  }
  base.upstream = upstreamOut.stdout.trim()

  // Tracked changes only. An untracked file cannot block a fast-forward, and a
  // folder of agents almost always has some — caches, a `.venv`, the state an
  // agent wrote on its last run — so counting them would report every
  // repository as dirty and the feature would never be usable.
  const statusOut = await run(
    gitPath,
    repoRoot,
    ['status', '--porcelain', '--untracked-files=no'],
    LOCAL_TIMEOUT_MS
  )
  base.dirty = statusOut.ok && statusOut.stdout.trim() !== ''

  const countsOut = await run(
    gitPath,
    repoRoot,
    ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
    LOCAL_TIMEOUT_MS
  )
  if (countsOut.ok) {
    const [ahead, behind] = countsOut.stdout.trim().split(/\s+/)
    base.ahead = Number.parseInt(ahead ?? '0', 10) || 0
    base.behind = Number.parseInt(behind ?? '0', 10) || 0
  }

  if (base.behind > 0) {
    const logOut = await run(
      gitPath,
      repoRoot,
      ['log', LOG_FORMAT, `--max-count=${MAX_COMMITS}`, 'HEAD..@{upstream}'],
      LOCAL_TIMEOUT_MS
    )
    if (logOut.ok) base.incoming = parseCommits(logOut.stdout)
  }

  // A refusal is about *applying an update*, so there is none to state when
  // there is nothing to apply: a repository that is up to date but has
  // uncommitted work would otherwise report "there are uncommitted changes
  // here, commit or discard them" — a demand, on a folder where nothing is
  // waiting and nothing needs doing.
  //
  // Ordered by what the user can do about it. Local commits outrank local edits
  // because committing the edits does not help: the history is still diverged.
  if (base.behind > 0) {
    if (base.ahead > 0) base.refusal = 'diverged'
    else if (base.dirty) base.refusal = 'dirty'
  }

  return base
}

/**
 * A remote URL as something a browser can open, or null.
 *
 * Three shapes become links: `https://host/path`, `ssh://[user@]host/path` and
 * the scp-style `[user@]host:path` that `git@github.com:org/repo.git` is.
 * Everything else — a local path, a relative remote, `file://` — stays null
 * and the panel shows the raw URL as text. **A credential in the URL is
 * dropped**: `https://user:token@host/repo` is a real thing to find in a
 * remote, and putting it on screen as a clickable link would leak it to
 * anywhere the click goes and to every screenshot of this dialog.
 */
/**
 * A remote URL with any embedded credential removed, for display.
 *
 * `https://x-access-token:ghp_ABC@github.com/org/repo.git` is a real thing to
 * find in a working tree, and this string is shown as body text and as the
 * link's tooltip. The **password** is what goes; the username stays, because it
 * is not a secret and it is part of how the remote is reached. Handled for the
 * scheme'd forms and for the scp-style one alike.
 */
export function redactRemoteUrl(raw: string): string {
  const url = raw.trim()
  if (/^[a-z][\w+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      if (parsed.password === '') return url
      // The **password** only. A username is not a secret — `git`,
      // `x-access-token` — and it is part of how the remote is reached, so
      // dropping it would make the string stop matching what the user's own
      // `git remote -v` shows. This keeps the scheme'd and the scp-style
      // branches consistent: both keep the user, neither keeps the secret.
      parsed.password = ''
      return parsed.toString()
    } catch {
      return url
    }
  }
  // scp-style `[user[:pass]@]host:path` — drop only the password half, keeping
  // the `git@` that identifies how it is reached.
  return url.replace(/^([^/@]*?):[^/@]*@/, '$1@')
}

export function remoteWebUrl(raw: string): string | null {
  const url = raw.trim()
  if (url === '') return null

  const strip = (path: string): string => path.replace(/\.git$/, '')

  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      parsed.username = ''
      parsed.password = ''
      parsed.pathname = strip(parsed.pathname)
      return parsed.toString()
    } catch {
      return null
    }
  }

  if (/^ssh:\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      return `https://${parsed.hostname}${strip(parsed.pathname)}`
    } catch {
      return null
    }
  }

  // scp-style: [user@]host:path. The colon must not be followed by `//`, or it
  // is a scheme this does not handle.
  const scp = url.match(/^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/)
  if (scp) {
    const [, host, path] = scp
    // `user:ghp_TOKEN@host/repo` with no scheme parses as scp-style with
    // `host = user`, which would build a link whose *path* is the token. Git
    // does not read that as a working remote either, so refusing it costs
    // nothing and avoids putting a secret in a URL.
    if (path.includes('@')) return null
    return `https://${host}/${strip(path.replace(/^\/+/, ''))}`
  }

  return null
}

/**
 * Resolve a path through symlinks, or return it unchanged.
 *
 * Used only to compare two paths for identity. A path that cannot be resolved
 * (it went missing between the scan and now) falls back to itself, which at
 * worst reports a repository root the dialog then names — the same answer as
 * before, never a wrong one about a different folder.
 */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Everything the repository dialog shows, in one pass.
 *
 * Built **on top of** `readGitStatus` rather than beside it, so the dialog and
 * the row it opened from can never disagree about the branch or the counts.
 * The three extra reads are local and cheap; the only network is whatever
 * `fetch` asks `readGitStatus` for.
 */
export async function readGitDetail(dir: string, fetch = false): Promise<GitDetail> {
  const status = await readGitStatus(dir, fetch)
  const empty: GitDetail = {
    ...status,
    repoRootIsAbove: false,
    remotes: [],
    branches: [],
    head: null
  }
  if (!status.isRepo || status.repoRoot === null) return empty

  const gitPath = await resolveGit()
  if (!gitPath) return empty
  const repoRoot = status.repoRoot

  const [remoteOut, branchOut, headOut] = await Promise.all([
    run(gitPath, repoRoot, ['remote', '-v'], LOCAL_TIMEOUT_MS),
    // Sorted by most recent commit, so a repository with forty branches puts
    // the ones anyone is working on first.
    run(
      gitPath,
      repoRoot,
      ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/'],
      LOCAL_TIMEOUT_MS
    ),
    run(gitPath, repoRoot, ['log', '-1', LOG_FORMAT], LOCAL_TIMEOUT_MS)
  ])

  const remotes = new Map<string, GitRemote>()
  if (remoteOut.ok) {
    for (const line of remoteOut.stdout.split('\n')) {
      // `origin\thttps://…\t(fetch)` — one line per direction, and the two are
      // almost always the same URL, so the first wins and the second is
      // ignored rather than listed twice.
      const [name, rest] = line.split('\t')
      if (!name || !rest) continue
      const url = rest.replace(/\s*\((fetch|push)\)\s*$/, '').trim()
      if (url === '' || remotes.has(name)) continue
      remotes.set(name, { name, url: redactRemoteUrl(url), webUrl: remoteWebUrl(url) })
    }
  }

  const branches = branchOut.ok
    ? branchOut.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    : []
  // Current branch first — it is the one the update acts on.
  if (status.branch) {
    const rest = branches.filter((name) => name !== status.branch)
    branches.length = 0
    branches.push(status.branch, ...rest)
  }

  return {
    ...status,
    // Through realpath on both sides: `git rev-parse --show-toplevel` answers
    // with the resolved path, and the registered folder's is whatever the user
    // picked, so a symlinked location made a folder look like a repository
    // above itself.
    repoRootIsAbove: realOrSelf(repoRoot) !== realOrSelf(dir),
    remotes: [...remotes.values()],
    branches,
    head: headOut.ok ? (parseCommits(headOut.stdout)[0] ?? null) : null
  }
}

/**
 * Fast-forward a folder's repository to its upstream.
 *
 * Re-reads the status **with a fetch** first rather than trusting what the
 * renderer last saw: minutes may have passed since the check, and the whole
 * point of refusing on `dirty` and `diverged` is lost if the decision is made
 * from a stale snapshot. The commits reported as applied are the ones the
 * pre-merge status listed as incoming, which is why they are captured before
 * the merge rather than derived from the reflog afterwards.
 */
export async function updateGitRepo(dir: string): Promise<GitUpdateResult> {
  const before = await readGitStatus(dir, true)
  if (!before.isRepo || before.repoRoot === null) {
    return { updated: false, applied: [], refusal: before.refusal ?? 'not_a_repo', status: before }
  }
  if (before.refusal !== null) {
    return { updated: false, applied: [], refusal: before.refusal, status: before }
  }
  if (before.behind === 0) {
    return { updated: false, applied: [], refusal: null, status: before }
  }

  const gitPath = await resolveGit()
  if (!gitPath) {
    return { updated: false, applied: [], refusal: 'git_missing', status: before }
  }

  const merge = await run(
    gitPath,
    before.repoRoot,
    ['merge', '--ff-only', '@{upstream}'],
    LOCAL_TIMEOUT_MS
  )
  const after = await readGitStatus(dir, false)
  if (!merge.ok) {
    logger.warn('fast-forward refused', { stderr: merge.stderr.slice(0, 400) })
    return { updated: false, applied: [], refusal: 'not_fast_forward', status: after }
  }
  logger.info('agents folder updated', { commits: before.incoming.length })
  return { updated: true, applied: before.incoming, refusal: null, status: after }
}

// ---------------------------------------------------------------------------
// Sharing one agent folder with a team
// ---------------------------------------------------------------------------
//
// Everything above acts on a *root* and never writes history. What follows
// acts on one `Local/<slug>/` folder that is its **own** working tree with an
// `origin` — a shared agent — and does write: it records the folder's changes
// and sends them, and it brings the team's in. The rule that survives is the
// one that matters: it still never resolves a conflict. An update is a
// fast-forward, or a rebase that applies cleanly, or nothing at all
// (`rebase --abort`), and the user is offered two buttons instead.
//
// Every function takes a directory main has already resolved from an agent
// id, never a path from the renderer.

/**
 * How a sharing verb authenticates to `origin`.
 *
 * `external` keeps the user's own git setup (SSH agent, credential helper).
 * `cinna` carries the signed-in account's token, **minted by `token()`
 * immediately before each network child** rather than held as a string, so a
 * fetch and the push after it each get a token that is fresh at the moment
 * git opens the connection. `origin` is `scheme://host[:port]`: the only place
 * the header is sent.
 */
export type RemoteAuth =
  | { kind: 'external' }
  | { kind: 'cinna'; origin: string; token: () => Promise<string> }

/** Who a commit is from when the repository itself does not say. */
export interface CommitIdentity {
  name: string
  email: string
}

/** What one sharing verb did, before main dresses it as an `AgentShareResult`. */
export interface ShareActionResult {
  done: boolean
  refusal: ShareRefusal | null
  /** The server's own sentence, or what failed. Credential-scrubbed. */
  detail: string | null
}

/** A shared folder's counts, read from git. `state` is derived by {@link shareStateOf}. */
export interface ShareCounts {
  /** The folder is the top of its own working tree (not inside an ancestor's). */
  ownRepo: boolean
  /** `remote.origin.url` as configured, or null. May carry a credential: redact before showing. */
  originUrl: string | null
  headSha: string | null
  remoteHeadSha: string | null
  ahead: number
  /** -1 when the library says the team moved but the commit is not here yet. */
  behind: number
  changedFiles: number
  /** The paths behind `changedFiles`, in the order git listed them: new files first. */
  changedPaths: string[]
  fetched: boolean
  refusal: ShareRefusal | null
}

/** Most of the server's own words carried back in a refusal. */
const MAX_DETAIL_CHARS = 300

/** What the AI summary of a diff gets to read. */
const MAX_SUMMARY_DIFF_CHARS = 16_000

const done = (): ShareActionResult => ({ done: true, refusal: null, detail: null })
const refuse = (refusal: ShareRefusal, detail: string | null = null): ShareActionResult => ({
  done: false,
  refusal,
  detail
})

/**
 * The environment that carries a Cinna token to one git child (README §4.4 of
 * the team-sharing plan). Config through the environment: not argv, where a
 * process listing shows it, and not `.git/config`, where it outlives the
 * operation. The header is scoped to the remote's origin, so a submodule on
 * another host never receives it.
 *
 * **Redirects are switched off.** The URL scoping alone does not cover them:
 * git's default `http.followRedirects=initial` follows a redirect on the first
 * request and then sends every later request of the operation to the new base
 * URL — with the header the original origin's config matched. A Cinna remote
 * is the instance's own git endpoint and has no reason to redirect, so one
 * that does fails as `fetch_failed` rather than handing the token to wherever
 * it points.
 *
 * May throw: `token()` is `getCinnaAccessToken`, and an expired session is a
 * `CinnaReauthRequired` the caller turns into the app-wide prompt.
 */
async function authEnv(auth: RemoteAuth | null): Promise<Record<string, string>> {
  if (!auth || auth.kind !== 'cinna') return {}
  const token = await auth.token()
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${auth.origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    GIT_CONFIG_KEY_1: 'http.followRedirects',
    GIT_CONFIG_VALUE_1: 'false'
  }
}

/** One git child that reaches `origin`: the long timeout, and the auth env. */
async function runNet(
  gitPath: string,
  cwd: string,
  args: string[],
  auth: RemoteAuth | null
): Promise<RunResult> {
  return run(gitPath, cwd, args, NETWORK_TIMEOUT_MS, await authEnv(auth))
}

/**
 * Remove anything credential-shaped from text that may reach a log or the
 * renderer: a bearer header, a JWT, a password in a URL.
 */
export function scrubCredentials(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***')
    .replace(/([a-z][\w+.-]*:\/\/[^/\s:@]*):[^/\s@]*@/gi, '$1@')
}

/** The `remote:` lines of a git stderr — the server's own words — joined and capped. */
function remoteLines(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .filter((line) => line.startsWith('remote:'))
    .map((line) => line.replace(/^remote:\s?/, '').trim())
    .filter((line) => line !== '' && !/^(Counting|Compressing|Resolving|Total|Enumerating)/.test(line))
  if (lines.length === 0) return null
  return scrubCredentials(lines.join(' ')).slice(0, MAX_DETAIL_CHARS)
}

const NETWORK_FAILURE =
  /Could not resolve host|Failed to connect|Connection refused|Connection timed out|Operation timed out|unable to access|Could not read from remote repository|early EOF|RPC failed|SSL|timed out/i

const ACCESS_DENIED = /returned error: 403|\b403 Forbidden|Permission denied|not allowed to push|no write access/i

/** Why a push failed, from its stderr. `non_ff` is the one a retry may fix. */
function classifyPush(stderr: string): ShareActionResult | 'non_ff' {
  if (/\[rejected\][^\n]*\((non-fast-forward|fetch first)\)/.test(stderr)) return 'non_ff'
  if (/returned error: 403|\b403 Forbidden/i.test(stderr)) return refuse('no_access')
  if (/\[remote rejected\]|hook declined/i.test(stderr)) {
    const said = remoteLines(stderr)
    if (said && /permission denied|not allowed to push|no write access/i.test(said)) {
      return refuse('no_access', said)
    }
    return refuse('push_rejected', said)
  }
  if (ACCESS_DENIED.test(stderr)) return refuse('no_access')
  if (NETWORK_FAILURE.test(stderr) || stderr.trim() === '') return refuse('fetch_failed')
  const said = remoteLines(stderr)
  return refuse('push_rejected', said ?? scrubCredentials(lastLine(stderr)).slice(0, MAX_DETAIL_CHARS))
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines[lines.length - 1] ?? ''
}

function lines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line !== '')
}

function count(stdout: string): number {
  return Number.parseInt(stdout.trim(), 10) || 0
}

/** True when `dir` is the top of its own working tree — not a folder inside an ancestor repository. */
async function isOwnRepo(gitPath: string, dir: string): Promise<boolean> {
  const top = await run(gitPath, dir, ['rev-parse', '--show-toplevel'], LOCAL_TIMEOUT_MS)
  if (!top.ok || top.stdout.trim() === '') return false
  return realOrSelf(top.stdout.trim()) === realOrSelf(dir)
}

/** `remote.origin.url` as written — not `get-url`, which applies `insteadOf` rewrites. */
async function originUrlOf(gitPath: string, dir: string): Promise<string | null> {
  const out = await run(gitPath, dir, ['config', '--get', 'remote.origin.url'], LOCAL_TIMEOUT_MS)
  const url = out.ok ? out.stdout.trim() : ''
  return url === '' ? null : url
}

async function headOf(gitPath: string, dir: string): Promise<string | null> {
  const out = await run(gitPath, dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], LOCAL_TIMEOUT_MS)
  const sha = out.ok ? out.stdout.trim() : ''
  return sha === '' ? null : sha
}

/**
 * The team version's ref: `origin/main`, which every push here targets, or
 * whatever the branch tracks. Null before the first fetch of an empty remote.
 */
async function teamRef(gitPath: string, dir: string): Promise<string | null> {
  const main = await run(
    gitPath,
    dir,
    ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
    LOCAL_TIMEOUT_MS
  )
  if (main.ok && main.stdout.trim() !== '') return 'origin/main'
  const upstream = await run(
    gitPath,
    dir,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    LOCAL_TIMEOUT_MS
  )
  const name = upstream.ok ? upstream.stdout.trim() : ''
  return name === '' ? null : name
}

/**
 * The paths that differ from what the team has, counted as "N changes you
 * haven't shared": recorded-but-unsent versions and working-tree edits
 * (both relative to the **merge base**, so files only the team changed do not
 * count as this user's), plus untracked files the ignore rules do not exclude
 * — a new file is a change to share, `.env` and `app-data/` are not.
 */
async function changedPaths(
  gitPath: string,
  dir: string,
  head: string | null,
  ref: string | null
): Promise<Set<string>> {
  const paths = new Set<string>()
  const add = (out: RunResult): void => {
    if (out.ok) for (const path of lines(out.stdout)) paths.add(path)
  }
  add(await run(gitPath, dir, ['ls-files', '--others', '--exclude-standard'], LOCAL_TIMEOUT_MS))
  if (head === null) {
    // Nothing recorded yet: everything staged is unshared.
    add(await run(gitPath, dir, ['ls-files'], LOCAL_TIMEOUT_MS))
    return paths
  }
  let base: string | null = null
  if (ref !== null) {
    const mergeBase = await run(gitPath, dir, ['merge-base', 'HEAD', ref], LOCAL_TIMEOUT_MS)
    base = mergeBase.ok && mergeBase.stdout.trim() !== '' ? mergeBase.stdout.trim() : ref
  }
  if (base === null) {
    // Never shared: every tracked file is a change the team does not have.
    add(await run(gitPath, dir, ['ls-files'], LOCAL_TIMEOUT_MS))
    return paths
  }
  add(await run(gitPath, dir, ['diff', '--name-only', base], LOCAL_TIMEOUT_MS))
  return paths
}

const NOT_SHARED_COUNTS: ShareCounts = {
  ownRepo: false,
  originUrl: null,
  headSha: null,
  remoteHeadSha: null,
  ahead: 0,
  behind: 0,
  changedFiles: 0,
  changedPaths: [],
  fetched: false,
  refusal: 'not_shared'
}

/**
 * Whether a folder is its own repository with an `origin`, without counting
 * anything. Cheap: two local git reads.
 */
export async function readShareRemote(dir: string): Promise<{
  ownRepo: boolean
  originUrl: string | null
  /** The Cinna instance this folder was shared through, as {@link setCinnaServer} recorded it. */
  cinnaServer: string | null
  refusal: ShareRefusal | null
}> {
  const gitPath = await resolveGit()
  if (!gitPath) return { ownRepo: false, originUrl: null, cinnaServer: null, refusal: 'git_missing' }
  if (!(await isOwnRepo(gitPath, dir))) {
    return { ownRepo: false, originUrl: null, cinnaServer: null, refusal: 'not_shared' }
  }
  const [originUrl, server] = await Promise.all([
    originUrlOf(gitPath, dir),
    run(gitPath, dir, ['config', '--get', CINNA_SERVER_KEY], LOCAL_TIMEOUT_MS)
  ])
  const cinnaServer = server.ok && server.stdout.trim() !== '' ? server.stdout.trim() : null
  return { ownRepo: true, originUrl, cinnaServer, refusal: originUrl === null ? 'not_shared' : null }
}

/**
 * The `.git/config` key naming the Cinna instance (its API origin) a folder
 * was shared through or got from.
 *
 * Needed because an instance's git may live on a different origin from its
 * API — cinna-core builds `clone_url` from its backend address, while a
 * profile is often signed in through the web app's origin that proxies the
 * API (`localhost:5173` against `localhost:8000` in development, `app.` against
 * `api.` in a deployment). Without it, which profile's token a remote takes
 * would be known only once that profile's library listing had loaded. In
 * `.git/config`, so it is per machine, never part of what is shared, and not a
 * secret.
 */
const CINNA_SERVER_KEY = 'cinna.server'

/** Record which Cinna instance a shared folder belongs to. False when git refused. */
export async function setCinnaServer(dir: string, serverOrigin: string): Promise<boolean> {
  const gitPath = await resolveGit()
  if (!gitPath) return false
  const out = await run(gitPath, dir, ['config', CINNA_SERVER_KEY, serverOrigin], LOCAL_TIMEOUT_MS)
  return out.ok
}

/**
 * Forget which Cinna instance a folder was shared through — Remove sharing.
 * Best effort: an unset key is the end state either way.
 */
export async function unsetCinnaServer(dir: string): Promise<boolean> {
  const gitPath = await resolveGit()
  if (!gitPath) return false
  const out = await run(gitPath, dir, ['config', '--unset-all', CINNA_SERVER_KEY], LOCAL_TIMEOUT_MS)
  if (out.ok) return true
  // Exit 5 — the key was not set — is not a failure; anything else may be.
  const still = await run(gitPath, dir, ['config', '--get', CINNA_SERVER_KEY], LOCAL_TIMEOUT_MS)
  return !still.ok
}

/** One version of a folder's history as the Sharing tab lists it. */
export interface FolderVersion {
  note: string
  author: string
  date: string
  unsent: boolean
}

/** Most versions the Sharing tab lists. */
export const HISTORY_LIMIT = 30

/**
 * `<sha>\x1f<subject>\x1f<author>\x1f<iso date>\x1e` per version. Written with
 * git's own `%x1f`/`%x1e` escapes, so argv carries no control characters, and
 * split on the record separator rather than on newlines: a subject is one
 * line, but nothing else about a version's fields is promised.
 */
const HISTORY_FORMAT = '--format=%H%x1f%s%x1f%an%x1f%aI%x1e'

/**
 * A folder's versions, newest first, at most {@link HISTORY_LIMIT}. Each is
 * marked `unsent` when it is in `origin/main..HEAD` — recorded here, not on
 * the team version. Without an `origin/main` (never fetched, or not shared)
 * none is marked: there is nothing to measure against. Empty for a folder
 * that is not its own repository or has recorded nothing.
 */
export async function readHistory(dir: string, limit = HISTORY_LIMIT): Promise<FolderVersion[]> {
  const gitPath = await resolveGit()
  if (!gitPath || !(await isOwnRepo(gitPath, dir))) return []
  if ((await headOf(gitPath, dir)) === null) return []
  const log = await run(gitPath, dir, ['log', '-n', String(limit), HISTORY_FORMAT, 'HEAD'], LOCAL_TIMEOUT_MS)
  if (!log.ok) return []
  const team = await run(
    gitPath,
    dir,
    ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
    LOCAL_TIMEOUT_MS
  )
  const unsent = new Set<string>()
  if (team.ok && team.stdout.trim() !== '') {
    const ahead = await run(gitPath, dir, ['rev-list', 'refs/remotes/origin/main..HEAD'], LOCAL_TIMEOUT_MS)
    if (ahead.ok) for (const sha of lines(ahead.stdout)) unsent.add(sha.trim())
  }
  const out: FolderVersion[] = []
  for (const record of log.stdout.split('\x1e')) {
    const [sha, note, author, date] = record.replace(/^\n/, '').split('\x1f')
    if (!sha || sha.trim() === '') continue
    out.push({ note: note ?? '', author: author ?? '', date: (date ?? '').trim(), unsent: unsent.has(sha.trim()) })
  }
  return out
}

/**
 * A shared folder's counts against the team version.
 *
 * `fetch` reaches the network; without it the counts are as of the last
 * fetch — except `behind` for a Cinna remote, which `libraryHeadSha` (the
 * library listing's `head_sha`) answers without one: when the listing's head
 * is not in this folder's history the team has moved, by the counted amount
 * when the commit is already here and by -1 ("some") when it is not.
 */
export async function readShareStatus(
  dir: string,
  auth: RemoteAuth | null,
  fetch: boolean,
  libraryHeadSha?: string | null
): Promise<ShareCounts> {
  const gitPath = await resolveGit()
  if (!gitPath) return { ...NOT_SHARED_COUNTS, refusal: 'git_missing' }
  if (!(await isOwnRepo(gitPath, dir))) return { ...NOT_SHARED_COUNTS }
  const originUrl = await originUrlOf(gitPath, dir)
  if (originUrl === null) return { ...NOT_SHARED_COUNTS, ownRepo: true }

  const counts: ShareCounts = {
    ...NOT_SHARED_COUNTS,
    ownRepo: true,
    originUrl,
    refusal: null
  }

  if (fetch) {
    const fetched = await runNet(gitPath, dir, ['fetch', '--quiet', 'origin'], auth)
    if (fetched.ok) counts.fetched = true
    else {
      logger.warn('share status fetch failed', { stderr: scrubCredentials(fetched.stderr).slice(0, 400) })
      counts.refusal = 'fetch_failed'
    }
  }

  const head = await headOf(gitPath, dir)
  const ref = await teamRef(gitPath, dir)
  counts.headSha = head

  if (ref !== null) {
    const refSha = await run(gitPath, dir, ['rev-parse', '--verify', '--quiet', ref], LOCAL_TIMEOUT_MS)
    counts.remoteHeadSha = refSha.ok && refSha.stdout.trim() !== '' ? refSha.stdout.trim() : null
    if (head !== null) {
      const lr = await run(
        gitPath,
        dir,
        ['rev-list', '--left-right', '--count', `HEAD...${ref}`],
        LOCAL_TIMEOUT_MS
      )
      if (lr.ok) {
        const [ahead, behind] = lr.stdout.trim().split(/\s+/)
        counts.ahead = Number.parseInt(ahead ?? '0', 10) || 0
        counts.behind = Number.parseInt(behind ?? '0', 10) || 0
      }
    } else {
      counts.behind = count((await run(gitPath, dir, ['rev-list', '--count', ref], LOCAL_TIMEOUT_MS)).stdout)
    }
  } else if (head !== null) {
    counts.ahead = count((await run(gitPath, dir, ['rev-list', '--count', 'HEAD'], LOCAL_TIMEOUT_MS)).stdout)
  }

  if (libraryHeadSha) {
    counts.remoteHeadSha = libraryHeadSha
    if (libraryHeadSha !== head) {
      const inHistory =
        head !== null &&
        (await run(gitPath, dir, ['merge-base', '--is-ancestor', libraryHeadSha, 'HEAD'], LOCAL_TIMEOUT_MS)).ok
      if (!inHistory) {
        const present = (
          await run(gitPath, dir, ['cat-file', '-e', `${libraryHeadSha}^{commit}`], LOCAL_TIMEOUT_MS)
        ).ok
        if (present) {
          const range = head === null ? [libraryHeadSha] : [`HEAD..${libraryHeadSha}`]
          const n = count((await run(gitPath, dir, ['rev-list', '--count', ...range], LOCAL_TIMEOUT_MS)).stdout)
          counts.behind = Math.max(counts.behind, n)
        } else {
          counts.behind = -1
        }
      }
    }
  }

  counts.changedPaths = [...(await changedPaths(gitPath, dir, head, ref))]
  counts.changedFiles = counts.changedPaths.length
  return counts
}

/**
 * The status line's state from git alone. `other_account` and `removed`
 * outrank all of these and are decided by main, which knows the accounts and
 * the listing.
 */
export function shareStateOf(counts: Pick<ShareCounts, 'ahead' | 'behind' | 'changedFiles'>): AgentShareState {
  const unshared = counts.ahead > 0 || counts.changedFiles > 0
  if (counts.behind !== 0 && unshared) return 'diverged'
  if (counts.behind !== 0) return 'behind'
  if (unshared) return 'unshared'
  return 'up_to_date'
}

/**
 * Who a commit is from when neither the repository nor the caller says. The
 * `.invalid` top-level domain is reserved: the address can never reach anyone.
 */
export const ANONYMOUS_IDENTITY: CommitIdentity = {
  name: 'Cinna Desktop user',
  email: 'cinna-desktop@users.noreply.invalid'
}

/**
 * `-c` flags that make a commit possible in a repository with no identity.
 *
 * A repository (or the user's global config) that names someone keeps it: a
 * developer's commits stay theirs. Otherwise `identity` (main's, from the
 * Cinna profile), else {@link ANONYMOUS_IDENTITY} — never this machine's login
 * name and host name, which would publish both to the whole team in every
 * version. Signing is switched off for commits the app makes:
 * a `commit.gpgsign` from the user's global config would otherwise wait on a
 * pinentry this process has no terminal for.
 */
async function commitFlags(
  gitPath: string,
  dir: string,
  identity: CommitIdentity | null | undefined
): Promise<string[]> {
  const flags = ['-c', 'commit.gpgsign=false']
  const email = await run(gitPath, dir, ['config', '--get', 'user.email'], LOCAL_TIMEOUT_MS)
  const name = await run(gitPath, dir, ['config', '--get', 'user.name'], LOCAL_TIMEOUT_MS)
  const fallback: CommitIdentity = identity ?? ANONYMOUS_IDENTITY
  if (!name.ok || name.stdout.trim() === '') flags.push('-c', `user.name=${fallback.name}`)
  if (!email.ok || email.stdout.trim() === '') flags.push('-c', `user.email=${fallback.email}`)
  return flags
}

/**
 * Record everything in the folder as one version under `message`.
 *
 * `add -A -- .` honours the ignore rules, and the kit's are made sure of first
 * ({@link guardSecrets}): a folder whose own `.gitignore` is missing or does
 * not cover secrets — a developer's own repository — still keeps
 * `credentials/.env` and `app-data/` out, and one that already tracks a secret
 * is refused `secrets_tracked` before anything is recorded.
 *
 * `neverTravel` is for a Cinna team library: the folders that never travel
 * are also excluded, and anything already tracked under them is untracked
 * (left on disk) — the one place that happens.
 */
export async function commitAll(
  dir: string,
  message: string,
  identity?: CommitIdentity | null,
  workshopRoot?: string,
  neverTravel = false
): Promise<ShareActionResult> {
  const gitPath = await resolveGit()
  if (!gitPath) return refuse('git_missing')
  const guarded = await guardSecrets(gitPath, dir, workshopRoot, neverTravel, true)
  if (guarded) return guarded
  const add = await run(gitPath, dir, ['add', '-A', '--', '.'], LOCAL_TIMEOUT_MS)
  if (!add.ok) return refuse('failed', scrubCredentials(lastLine(add.stderr)).slice(0, MAX_DETAIL_CHARS))
  const head = await headOf(gitPath, dir)
  const staged =
    head === null
      ? (await run(gitPath, dir, ['ls-files'], LOCAL_TIMEOUT_MS)).stdout.trim() !== ''
      : !(await run(gitPath, dir, ['diff', '--cached', '--quiet'], LOCAL_TIMEOUT_MS)).ok
  if (!staged) return refuse('nothing_to_share')
  const text = message.trim() === '' ? 'Changes shared from Cinna Desktop' : message.trim()
  const commit = await run(
    gitPath,
    dir,
    [...(await commitFlags(gitPath, dir, identity)), 'commit', '--quiet', '-m', text],
    LOCAL_TIMEOUT_MS
  )
  if (!commit.ok) {
    logger.warn('commit failed', { stderr: scrubCredentials(commit.stderr).slice(0, 400) })
    return refuse('failed', scrubCredentials(lastLine(commit.stderr)).slice(0, MAX_DETAIL_CHARS))
  }
  return done()
}

/**
 * Bring in the team's changes when they apply cleanly.
 *
 * Fetch; nothing to do when not behind. Refuses `dirty` while tracked files
 * have edits, or while an untracked file sits where an incoming one would
 * land — either would be overwritten or block. Fast-forwards when nothing
 * here is recorded-but-unsent; otherwise rebases those versions onto the
 * team's, and when that does not apply cleanly aborts it (the tree is exactly
 * as it was) and answers `diverged_conflict`.
 */
export async function pullRebaseClean(
  dir: string,
  auth: RemoteAuth | null,
  identity?: CommitIdentity | null,
  workshopRoot?: string
): Promise<ShareActionResult> {
  const gitPath = await resolveGit()
  if (!gitPath) return refuse('git_missing')
  const fetched = await runNet(gitPath, dir, ['fetch', '--quiet', 'origin'], auth)
  if (!fetched.ok) {
    logger.warn('share fetch failed', { stderr: scrubCredentials(fetched.stderr).slice(0, 400) })
    return refuse('fetch_failed')
  }
  const ref = await teamRef(gitPath, dir)
  if (ref === null) return { done: false, refusal: null, detail: null }
  const head = await headOf(gitPath, dir)
  const behind =
    head === null
      ? count((await run(gitPath, dir, ['rev-list', '--count', ref], LOCAL_TIMEOUT_MS)).stdout)
      : count((await run(gitPath, dir, ['rev-list', '--count', `HEAD..${ref}`], LOCAL_TIMEOUT_MS)).stdout)
  if (behind === 0) return { done: false, refusal: null, detail: null }

  const status = await run(gitPath, dir, ['status', '--porcelain', '--untracked-files=no'], LOCAL_TIMEOUT_MS)
  if (status.ok && status.stdout.trim() !== '') return refuse('dirty')
  const untracked = new Set(
    lines((await run(gitPath, dir, ['ls-files', '--others', '--exclude-standard'], LOCAL_TIMEOUT_MS)).stdout)
  )
  if (untracked.size > 0) {
    const incoming = head === null
      ? lines((await run(gitPath, dir, ['ls-tree', '-r', '--name-only', ref], LOCAL_TIMEOUT_MS)).stdout)
      : lines((await run(gitPath, dir, ['diff', '--name-only', `HEAD...${ref}`], LOCAL_TIMEOUT_MS)).stdout)
    if (incoming.some((path) => untracked.has(path))) return refuse('dirty')
  }

  const ahead = head === null ? 0 : count((await run(gitPath, dir, ['rev-list', '--count', `${ref}..HEAD`], LOCAL_TIMEOUT_MS)).stdout)
  if (ahead === 0) {
    const merge = await run(gitPath, dir, ['merge', '--ff-only', '--quiet', ref], LOCAL_TIMEOUT_MS)
    if (!merge.ok) {
      logger.warn('share fast-forward refused', { stderr: scrubCredentials(merge.stderr).slice(0, 400) })
      return refuse('failed', scrubCredentials(lastLine(merge.stderr)).slice(0, MAX_DETAIL_CHARS))
    }
    return done()
  }
  if (isCinna(auth)) {
    // Before the rebase: replaying a version that untracked a never-travel
    // file deletes that file from the working tree; the rewritten version no
    // longer touches it.
    const rewritten = await rewriteUnsent(gitPath, dir, neverTravelPaths(workshopRoot))
    if (rewritten) return rewritten
  }
  const rebase = await run(
    gitPath,
    dir,
    [...(await commitFlags(gitPath, dir, identity)), 'rebase', '--quiet', '--no-autostash', ref],
    LOCAL_TIMEOUT_MS
  )
  if (!rebase.ok) {
    await run(gitPath, dir, ['rebase', '--abort'], LOCAL_TIMEOUT_MS)
    logger.info('share rebase did not apply cleanly; aborted')
    return refuse('diverged_conflict')
  }
  return done()
}

/**
 * Send what is recorded here to the team, as `main`.
 *
 * A non-fast-forward means a teammate shared first: one clean
 * {@link pullRebaseClean} and one more push, never a force. Its refusals —
 * `dirty`, `diverged_conflict` — are the answer when it cannot.
 */
export async function push(
  dir: string,
  auth: RemoteAuth | null,
  identity?: CommitIdentity | null,
  workshopRoot?: string
): Promise<ShareActionResult> {
  const gitPath = await resolveGit()
  if (!gitPath) return refuse('git_missing')
  const args = ['push', '--quiet', '-u', 'origin', 'HEAD:main']
  let attempt = await runNet(gitPath, dir, args, auth)
  if (attempt.ok) return done()
  let verdict = classifyPush(attempt.stderr)
  if (verdict === 'non_ff') {
    const pulled = await pullRebaseClean(dir, auth, identity, workshopRoot)
    if (pulled.refusal !== null) return pulled
    if (isCinna(auth)) {
      // The rebased versions came from ones already cleared; this is a no-op
      // unless something under the never-travel folders slipped back in.
      const rewritten = await rewriteUnsent(gitPath, dir, neverTravelPaths(workshopRoot))
      if (rewritten) return rewritten
    }
    attempt = await runNet(gitPath, dir, args, auth)
    if (attempt.ok) return done()
    verdict = classifyPush(attempt.stderr)
    if (verdict === 'non_ff') {
      return refuse('push_rejected', 'The team version changed again while sending.')
    }
  }
  logger.warn('share push refused', {
    refusal: verdict.refusal,
    stderr: scrubCredentials(attempt.stderr).slice(0, 400)
  })
  return verdict
}

/**
 * Share changes: record anything unrecorded under `message`, then send
 * whatever the team does not have. `nothing_to_share` when there is neither.
 */
export async function shareChanges(
  dir: string,
  message: string,
  auth: RemoteAuth | null,
  identity?: CommitIdentity | null,
  workshopRoot?: string
): Promise<ShareActionResult> {
  const gitPath = await resolveGit()
  if (!gitPath) return refuse('git_missing')
  const committed = await commitAll(dir, message, identity, workshopRoot, isCinna(auth))
  if (committed.refusal !== null && committed.refusal !== 'nothing_to_share') return committed
  const ref = await teamRef(gitPath, dir)
  const head = await headOf(gitPath, dir)
  if (head === null) return refuse('nothing_to_share')
  const ahead =
    ref === null
      ? count((await run(gitPath, dir, ['rev-list', '--count', 'HEAD'], LOCAL_TIMEOUT_MS)).stdout)
      : count((await run(gitPath, dir, ['rev-list', '--count', `${ref}..HEAD`], LOCAL_TIMEOUT_MS)).stdout)
  if (ahead === 0) return refuse('nothing_to_share')
  if (isCinna(auth)) {
    const cleared = await dropNeverTravelsFromUnsent(gitPath, dir, auth, identity, workshopRoot)
    if (cleared) return cleared
  }
  return push(dir, auth, identity, workshopRoot)
}

/** What would be shared, as text for the AI summary: the diff from the team version and the new files' names. */
export async function diffForSummary(dir: string): Promise<string> {
  const gitPath = await resolveGit()
  if (!gitPath) return ''
  const head = await headOf(gitPath, dir)
  const ref = await teamRef(gitPath, dir)
  let base: string | null = null
  if (head !== null && ref !== null) {
    const mergeBase = await run(gitPath, dir, ['merge-base', 'HEAD', ref], LOCAL_TIMEOUT_MS)
    base = mergeBase.ok && mergeBase.stdout.trim() !== '' ? mergeBase.stdout.trim() : ref
  } else if (head !== null) {
    base = null
  }
  // A tracked secret would be refused at Share, but this runs when the dialog
  // opens and its text goes to an AI backend: leave those files out.
  const secrets = head !== null ? await trackedSecrets(gitPath, dir, undefined) : []
  const excluded = Array.isArray(secrets) ? secrets.map((rel) => `:(exclude,literal)${rel}`) : []
  const parts: string[] = []
  if (base !== null) {
    const diff = await run(gitPath, dir, ['diff', '--no-color', base, '--', '.', ...excluded], LOCAL_TIMEOUT_MS)
    if (diff.ok && diff.stdout.trim() !== '') parts.push(diff.stdout)
  } else if (head !== null) {
    const tracked = await run(gitPath, dir, ['ls-files'], LOCAL_TIMEOUT_MS)
    if (tracked.ok && tracked.stdout.trim() !== '') parts.push(`Files:\n${tracked.stdout}`)
  }
  const untracked = await run(gitPath, dir, ['ls-files', '--others', '--exclude-standard'], LOCAL_TIMEOUT_MS)
  if (untracked.ok && untracked.stdout.trim() !== '') parts.push(`New files:\n${untracked.stdout}`)
  return parts.join('\n\n').slice(0, MAX_SUMMARY_DIFF_CHARS)
}

/**
 * Keep an enclosing repository from seeing a nested one.
 *
 * A workshop root is often itself a repository; a `Local/<slug>/` that
 * becomes its own repo would otherwise show up there as an untracked
 * directory (or a stray gitlink once somebody runs `git add -A`). The path,
 * relative to that repository's top, goes into its `.git/info/exclude` —
 * per clone, never committed, and only once.
 */
export async function excludeFromEnclosingRepo(dir: string): Promise<void> {
  const parent = dirname(dir)
  if (!looksLikeGitRepo(parent)) return
  const gitPath = await resolveGit()
  if (!gitPath) return
  const top = await run(gitPath, parent, ['rev-parse', '--show-toplevel'], LOCAL_TIMEOUT_MS)
  if (!top.ok || top.stdout.trim() === '') return
  const common = await run(
    gitPath,
    parent,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    LOCAL_TIMEOUT_MS
  )
  if (!common.ok || common.stdout.trim() === '') return
  const rel = relative(realOrSelf(top.stdout.trim()), realOrSelf(dir)).split(sep).join('/')
  if (rel === '' || rel.startsWith('..')) return
  const line = `/${rel}/`
  const file = join(common.stdout.trim(), 'info', 'exclude')
  try {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (existing.split('\n').some((entry) => entry.trim() === line)) return
    mkdirSync(dirname(file), { recursive: true })
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
    appendFileSync(file, `${prefix}${line}\n`)
  } catch (err) {
    logger.warn('could not exclude a nested agent repository', { error: String(err) })
  }
}

/**
 * Contract 1.8.0's `never_travels`, for a contract that predates it: the
 * layout is read from the workshop's own `.cinna-kit/` when it has one, and a
 * workshop made before 1.8.0 still has an older copy. The server enforces
 * these whatever the folder's contract says.
 */
const NEVER_TRAVELS_FALLBACK = ['credentials/', 'app-data/']

/**
 * Agent-relative folders (each ending `/`) that never go to a shared remote:
 * the agent's credentials and its per-machine runtime data, **whole** — the
 * team library's server refuses a version carrying any file under them,
 * including the kit template's own `credentials/README.md`.
 */
export function neverTravelPaths(workshopRoot?: string): string[] {
  let paths: string[] | undefined
  try {
    paths = getLayout(workshopRoot).never_travels
  } catch {
    paths = undefined
  }
  const list = paths && paths.length > 0 ? paths : NEVER_TRAVELS_FALLBACK
  return list.map((path) => (path.endsWith('/') ? path : `${path}/`))
}

function travelsNot(rel: string, never: string[]): boolean {
  return never.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))
}

/** A Cinna team library — the only kind of remote the never-travel rules apply to. */
function isCinna(auth: RemoteAuth | null | undefined): boolean {
  return auth?.kind === 'cinna'
}

/**
 * Stop recording anything under a never-travelling folder. The files stay on
 * disk; only the index forgets them, and the exclude block keeps them out of
 * every later `add -A`.
 */
async function untrackNeverTravels(gitPath: string, dir: string, never: string[]): Promise<boolean> {
  const out = await run(
    gitPath,
    dir,
    ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...never.map((path) => path.slice(0, -1))],
    LOCAL_TIMEOUT_MS
  )
  return out.ok
}

const failedWith = (out: RunResult): ShareActionResult =>
  refuse('failed', scrubCredentials(lastLine(out.stderr)).slice(0, MAX_DETAIL_CHARS) || null)

/**
 * Before a send to a Cinna team library, which checks **every** new version,
 * not only the latest: a never-travelling file recorded in any version not yet
 * sent would refuse the whole send even after it was untracked.
 *
 * Fetches first, so "not yet sent" is measured against the team's version as
 * it is now; then drops those paths from the unsent versions
 * ({@link rewriteUnsent}); then, when the team has moved on, rebases them
 * onto it ({@link pullRebaseClean}, whose `dirty` and `diverged_conflict`
 * are the answer when it cannot). The rewrite comes **before** the rebase:
 * replaying a version that untracked a file deletes that file from the
 * working tree, and the rewritten one no longer untracks anything.
 */
async function dropNeverTravelsFromUnsent(
  gitPath: string,
  dir: string,
  auth: RemoteAuth | null,
  identity: CommitIdentity | null | undefined,
  workshopRoot: string | undefined
): Promise<ShareActionResult | null> {
  const fetched = await runNet(gitPath, dir, ['fetch', '--quiet', 'origin'], auth)
  if (!fetched.ok) {
    logger.warn('share fetch failed', { stderr: scrubCredentials(fetched.stderr).slice(0, 400) })
    return refuse('fetch_failed')
  }
  const rewritten = await rewriteUnsent(gitPath, dir, neverTravelPaths(workshopRoot))
  if (rewritten) return rewritten
  const ref = await teamRef(gitPath, dir)
  if (ref === null || (await headOf(gitPath, dir)) === null) return null
  const contained = await run(gitPath, dir, ['merge-base', '--is-ancestor', ref, 'HEAD'], LOCAL_TIMEOUT_MS)
  if (contained.ok) return null
  const pulled = await pullRebaseClean(dir, auth, identity, workshopRoot)
  return pulled.refusal !== null ? pulled : null
}

/**
 * Drop the never-travelling paths from every version the team does not have
 * — `<team ref>..HEAD`, or all of HEAD's history when there is no team ref
 * (nothing was ever accepted). Each version keeps its message, author,
 * committer and dates, and its place: a developer's history survives, only
 * those paths vanish from it. Nothing reachable from the team ref is ever
 * rewritten. The trees are built in a temporary index; the working tree and
 * the real index are untouched, and the branch moves by compare-and-swap.
 * Null when done or when there was nothing to drop.
 */
async function rewriteUnsent(gitPath: string, dir: string, never: string[]): Promise<ShareActionResult | null> {
  const oldTip = await headOf(gitPath, dir)
  if (oldTip === null) return null
  const ref = await teamRef(gitPath, dir)
  const range = ref === null ? [oldTip] : [oldTip, '--not', ref]
  const roots = never.map((path) => path.slice(0, -1))
  const touching = await run(
    gitPath,
    dir,
    ['rev-list', '--full-history', ...range, '--', ...roots],
    LOCAL_TIMEOUT_MS
  )
  if (!touching.ok) return failedWith(touching)
  if (touching.stdout.trim() === '') return null

  const branch = await run(gitPath, dir, ['symbolic-ref', '-q', 'HEAD'], LOCAL_TIMEOUT_MS)
  const branchRef = branch.ok ? branch.stdout.trim() : ''
  if (branchRef === '') {
    return refuse(
      'failed',
      'This folder is not on a branch (detached HEAD). Switch to its branch and share again; the credentials and app-data folders have to be left out of versions not yet sent.'
    )
  }

  const listed = await run(
    gitPath,
    dir,
    ['rev-list', '--reverse', '--topo-order', '--parents', ...range],
    LOCAL_TIMEOUT_MS
  )
  if (!listed.ok) return failedWith(listed)

  const gitDirOut = await run(gitPath, dir, ['rev-parse', '--absolute-git-dir'], LOCAL_TIMEOUT_MS)
  if (!gitDirOut.ok || gitDirOut.stdout.trim() === '') return failedWith(gitDirOut)
  const scratch = join(gitDirOut.stdout.trim(), `cinna-rewrite-${randomBytes(4).toString('hex')}`)
  const indexFile = `${scratch}.index`
  const messageFile = `${scratch}.msg`
  const mapped = new Map<string, string>()
  let newTip = oldTip
  try {
    for (const line of lines(listed.stdout)) {
      const [commit, ...parents] = line.trim().split(/\s+/)
      const index = { GIT_INDEX_FILE: indexFile }
      const read = await run(gitPath, dir, ['read-tree', commit], LOCAL_TIMEOUT_MS, index)
      if (!read.ok) return failedWith(read)
      // `-f`: `rm --cached` still compares the scratch index against the real
      // HEAD and working tree, and refuses a path whose file was edited since
      // that version recorded it ("staged content different from both") —
      // which would block every share for good. This index is ours to throw away.
      const removed = await run(
        gitPath,
        dir,
        ['rm', '-r', '--cached', '-f', '--quiet', '--ignore-unmatch', '--', ...roots],
        LOCAL_TIMEOUT_MS,
        index
      )
      if (!removed.ok) return failedWith(removed)
      const written = await run(gitPath, dir, ['write-tree'], LOCAL_TIMEOUT_MS, index)
      if (!written.ok) return failedWith(written)
      const tree = written.stdout.trim()

      const meta = await run(
        gitPath,
        dir,
        // A user's `log.showSignature` would print the signature check ahead of
        // the formatted line and shift every field.
        ['-c', 'log.showSignature=false', 'log', '-1', '--date=raw', '--format=%T%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd', commit],
        LOCAL_TIMEOUT_MS
      )
      if (!meta.ok) return failedWith(meta)
      const [oldTree, an, ae, ad, cn, ce, cd] = meta.stdout.trim().split('\x1f')
      const newParents = parents.map((parent) => mapped.get(parent) ?? parent)
      if (tree === oldTree && newParents.every((parent, i) => parent === parents[i])) {
        // Nothing to drop here and nothing below it changed: the version stays as it is.
        mapped.set(commit, commit)
        newTip = commit
        continue
      }

      // The message from the raw object rather than `%B`. Read as UTF-8, so a
      // message in another `encoding` is not carried byte for byte (known limit).
      const raw = await run(gitPath, dir, ['cat-file', 'commit', commit], LOCAL_TIMEOUT_MS)
      if (!raw.ok) return failedWith(raw)
      const split = raw.stdout.indexOf('\n\n')
      writeFileSync(messageFile, split < 0 ? '' : raw.stdout.slice(split + 2))
      const made = await run(
        gitPath,
        dir,
        [
          '-c',
          'commit.gpgsign=false',
          'commit-tree',
          tree,
          ...newParents.flatMap((parent) => ['-p', parent]),
          '-F',
          messageFile
        ],
        LOCAL_TIMEOUT_MS,
        {
          GIT_AUTHOR_NAME: an ?? '',
          GIT_AUTHOR_EMAIL: ae ?? '',
          GIT_AUTHOR_DATE: ad ?? '',
          GIT_COMMITTER_NAME: cn ?? '',
          GIT_COMMITTER_EMAIL: ce ?? '',
          GIT_COMMITTER_DATE: cd ?? ''
        }
      )
      const sha = made.stdout.trim()
      if (!made.ok || sha === '') return failedWith(made)
      mapped.set(commit, sha)
      newTip = sha
    }
  } catch (err) {
    return refuse('failed', String(err).slice(0, MAX_DETAIL_CHARS))
  } finally {
    rmSync(indexFile, { force: true })
    rmSync(messageFile, { force: true })
  }

  if (newTip === oldTip) return null
  const moved = await run(
    gitPath,
    dir,
    ['update-ref', '-m', 'cinna: leave the never-travel folders out of unsent versions', branchRef, newTip, oldTip],
    LOCAL_TIMEOUT_MS
  )
  if (!moved.ok) return failedWith(moved)
  logger.info('dropped never-travelling files from unsent versions', { versions: mapped.size })
  return null
}

/**
 * Give a folder that came from a team version the never-travelling folders
 * the kit's agent template has — `credentials/` with its README and
 * `.env.example`, `app-data/` with its subfolders — since the team version
 * never carries them. Only what is missing; dotless template ignore files get
 * their dot back, as the scaffold does.
 */
export function restoreLocalOnlyFolders(dir: string, workshopRoot?: string): void {
  const templateRoot = getTemplateRoot('agent', workshopRoot)
  const never = neverTravelPaths(workshopRoot)
  for (const path of never) {
    const source = join(templateRoot, ...path.slice(0, -1).split('/'))
    if (!existsSync(source)) continue
    cpSync(source, join(dir, ...path.slice(0, -1).split('/')), {
      recursive: true,
      force: false,
      errorOnExist: false
    })
  }
  for (const [from, to] of getLayoutView(workshopRoot).scaffoldIgnoreFiles('agent')) {
    if (!travelsNot(from, never)) continue
    const dotless = join(dir, ...from.split('/'))
    const dotted = join(dir, ...to.split('/'))
    if (existsSync(dotless) && !existsSync(dotted)) renameSync(dotless, dotted)
  }
}

/** The first and last line of the block {@link ensureAgentExcludes} keeps in `.git/info/exclude`. */
const EXCLUDE_BEGIN = '# >>> Cinna Desktop: the agent kit\'s ignore rules (managed; edits here are replaced)'
const EXCLUDE_END = '# <<< Cinna Desktop'

/**
 * The rules of the kit's agent `.gitignore` template — secrets, Python
 * environments, runtime data — read from the contract through
 * `layout.json`'s `scaffold_ignore_files`, never hard-coded. Comments and
 * blank lines dropped.
 */
function kitAgentIgnoreRules(workshopRoot: string | undefined): string[] {
  const pair = getLayoutView(workshopRoot)
    .scaffoldIgnoreFiles('agent')
    .find(([, to]) => to === '.gitignore')
  if (!pair) throw new Error('the kit names no agent .gitignore')
  const source = join(getTemplateRoot('agent', workshopRoot), ...pair[0].split('/'))
  return readFileSync(source, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/**
 * Make sure the folder's own `.git/info/exclude` carries the kit's agent
 * ignore rules, so what `add -A` records never depends on the `.gitignore` a
 * developer (or a teammate) left in the folder. Per clone, never committed,
 * and idempotent: one marked block, rewritten only when the kit's rules
 * changed. False when it could not be made sure of — a caller about to record
 * must not go on.
 */
async function ensureAgentExcludes(
  gitPath: string,
  dir: string,
  workshopRoot: string | undefined,
  neverTravel: boolean
): Promise<boolean> {
  try {
    // The never-travel folders only for a Cinna team library; any other
    // remote gets the kit's ordinary rules alone.
    const never = neverTravel ? neverTravelPaths(workshopRoot).map((path) => `/${path}`) : []
    const block = [EXCLUDE_BEGIN, ...kitAgentIgnoreRules(workshopRoot), ...never, EXCLUDE_END].join('\n')
    const at = await run(
      gitPath,
      dir,
      ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      LOCAL_TIMEOUT_MS
    )
    if (!at.ok || at.stdout.trim() === '') return false
    const file = at.stdout.trim()
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const begin = existing.indexOf(EXCLUDE_BEGIN)
    const end = begin < 0 ? -1 : existing.indexOf(EXCLUDE_END, begin)
    let next: string
    if (begin >= 0 && end >= 0) {
      if (existing.slice(begin, end + EXCLUDE_END.length) === block) return true
      next = existing.slice(0, begin) + block + existing.slice(end + EXCLUDE_END.length)
    } else {
      const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
      next = `${existing}${prefix}${block}\n`
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, next)
    return true
  } catch (err) {
    logger.warn('could not write the kit ignore rules into info/exclude', { error: String(err) })
    return false
  }
}

/**
 * Tracked files that can hold a credential value — `secret_files` (through
 * the validator's `isSecretFile`, which applies the contract's rules) and the
 * desktop-owned `app-data/desktop.json`, which holds a bearer token. A string
 * is the reason `ls-files` could not answer.
 */
async function trackedSecrets(
  gitPath: string,
  dir: string,
  workshopRoot: string | undefined
): Promise<string[] | string> {
  const tracked = await run(gitPath, dir, ['ls-files', '-z'], LOCAL_TIMEOUT_MS)
  if (!tracked.ok) return scrubCredentials(lastLine(tracked.stderr)).slice(0, MAX_DETAIL_CHARS)
  let layout: ReturnType<typeof getLayoutView> | undefined
  try {
    layout = getLayoutView(workshopRoot)
  } catch {
    layout = undefined
  }
  const owned = new Set(layout?.desktopOwned() ?? ['app-data/desktop.json'])
  return tracked.stdout
    .split('\0')
    .filter((rel) => rel !== '' && (owned.has(rel) || isSecretFile(rel, layout)))
}

/**
 * Share with the team's check before the library entry is created, so a
 * folder that would be refused does not leave an entry behind with nothing
 * sent to it. Only a folder that is already its own repository can track a
 * secret; any other is cleared here and guarded again when it is recorded.
 *
 * **Read-only** apart from the exclude block: nothing is untracked and the
 * index is not touched. With `neverTravel` (a Cinna library) a tracked secret
 * under the folders that never travel is not a refusal — the record step
 * untracks it and the send leaves it out of every version.
 */
export async function preflightShare(
  dir: string,
  workshopRoot?: string,
  neverTravel = false
): Promise<ShareActionResult | null> {
  const gitPath = await resolveGit()
  if (!gitPath) return refuse('git_missing')
  if (!(await isOwnRepo(gitPath, dir))) return null
  return guardSecrets(gitPath, dir, workshopRoot, neverTravel, false)
}

/**
 * Before anything is recorded: the kit's ignore rules in place, and no file
 * that can hold a credential value already tracked — `secret_files` (through
 * the validator's `isSecretFile`, which applies the contract's rules) and the
 * desktop-owned `app-data/desktop.json`, which holds a bearer token. An
 * ignore rule cannot untrack a file, so such a folder is refused
 * `secrets_tracked` and nothing is recorded or sent. Null when clear.
 */
async function guardSecrets(
  gitPath: string,
  dir: string,
  workshopRoot: string | undefined,
  neverTravel: boolean,
  untrack: boolean
): Promise<ShareActionResult | null> {
  if (!(await ensureAgentExcludes(gitPath, dir, workshopRoot, neverTravel))) {
    return refuse('failed', 'The ignore rules could not be written.')
  }
  const never = neverTravel ? neverTravelPaths(workshopRoot) : []
  if (neverTravel && untrack && !(await untrackNeverTravels(gitPath, dir, never))) {
    return refuse('failed', 'The credentials and app-data folders could not be left out.')
  }
  const found = await trackedSecrets(gitPath, dir, workshopRoot)
  if (typeof found === 'string') return refuse('failed', found)
  // Under a never-travel folder a tracked secret is untracked at record time
  // and dropped from unsent versions before the send: not a refusal.
  const secrets = found.filter((rel) => !travelsNot(rel, never))
  if (secrets.length === 0) return null
  logger.warn('refusing to record a folder that tracks secret files', { count: secrets.length })
  return refuse('secrets_tracked', secrets.slice(0, 3).join(', '))
}

/**
 * Write the kit's agent ignore files that are missing, from the contract's
 * own template through `layout.json`'s `scaffold_ignore_files` — so an agent
 * made before the folder was a repository does not send its secrets with the
 * first share. Only the folder-level pairs; one that exists is never touched.
 */
function writeMissingIgnoreFiles(dir: string, workshopRoot: string | undefined): void {
  const templateRoot = getTemplateRoot('agent', workshopRoot)
  for (const [from, to] of getLayoutView(workshopRoot).scaffoldIgnoreFiles('agent')) {
    if (to.includes('/')) continue
    const target = join(dir, to)
    if (existsSync(target)) continue
    const source = join(templateRoot, ...from.split('/'))
    if (!existsSync(source)) continue
    writeFileSync(target, readFileSync(source))
  }
}

/**
 * Make a folder the first version of a team agent at `url`, in place.
 *
 * `git init -b main` when the folder is not already its own repository (a
 * developer's existing repo keeps its history), the kit's ignore file when
 * absent, `origin`, one version of everything, and the first send.
 */
export async function initWithRemote(
  dir: string,
  url: string,
  auth: RemoteAuth | null,
  options: { workshopRoot?: string; identity?: CommitIdentity | null } = {}
): Promise<ShareActionResult> {
  const gitPath = await resolveGit()
  if (!gitPath) return refuse('git_missing')
  const own = await isOwnRepo(gitPath, dir)
  if (own && (await originUrlOf(gitPath, dir)) !== null) return refuse('remote_exists')
  if (!own) {
    const init = await run(gitPath, dir, ['init', '--quiet', '-b', 'main'], LOCAL_TIMEOUT_MS)
    if (!init.ok) return refuse('failed', scrubCredentials(lastLine(init.stderr)).slice(0, MAX_DETAIL_CHARS))
    await excludeFromEnclosingRepo(dir)
  }
  try {
    writeMissingIgnoreFiles(dir, options.workshopRoot)
  } catch (err) {
    return refuse('failed', `The ignore file could not be written: ${String(err)}`.slice(0, MAX_DETAIL_CHARS))
  }
  // Before `origin` is added, so a folder refused here is not left looking
  // shared. A check only: untracking is `commitAll`'s.
  const neverTravel = isCinna(auth)
  const guarded = await guardSecrets(gitPath, dir, options.workshopRoot, neverTravel, false)
  if (guarded) return guarded
  const remote = await run(gitPath, dir, ['remote', 'add', 'origin', url], LOCAL_TIMEOUT_MS)
  if (!remote.ok) return refuse('failed', scrubCredentials(lastLine(remote.stderr)).slice(0, MAX_DETAIL_CHARS))
  const committed = await commitAll(dir, 'Shared with the team', options.identity, options.workshopRoot, neverTravel)
  if (committed.refusal !== null && committed.refusal !== 'nothing_to_share') return committed
  if (neverTravel) {
    const cleared = await dropNeverTravelsFromUnsent(gitPath, dir, auth, options.identity, options.workshopRoot)
    if (cleared) return cleared
  }
  return push(dir, auth, options.identity, options.workshopRoot)
}

/**
 * A full clone of the team version into `targetDir`, which must not exist.
 *
 * Cloned into a hidden staging sibling and renamed into place, so the
 * scanner and the watcher never see half an agent and a failure leaves
 * nothing. What arrives must have `cinna-agent.json` at its root.
 */
export async function clone(
  url: string,
  targetDir: string,
  auth: RemoteAuth | null,
  workshopRoot?: string
): Promise<ShareActionResult> {
  if (existsSync(targetDir)) return refuse('exists')
  const gitPath = await resolveGit()
  if (!gitPath) return refuse('git_missing')
  const parent = dirname(targetDir)
  const staging = join(parent, `.${basename(targetDir)}.clone-${randomBytes(4).toString('hex')}`)
  const cleanup = (): void => {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      /* already gone */
    }
  }
  try {
    mkdirSync(parent, { recursive: true })
  } catch (err) {
    return refuse('failed', String(err).slice(0, MAX_DETAIL_CHARS))
  }
  const cloned = await runNet(
    gitPath,
    parent,
    ['clone', '--quiet', '--single-branch', '--', url, staging],
    auth
  )
  if (!cloned.ok) {
    cleanup()
    logger.warn('share clone failed', { stderr: scrubCredentials(cloned.stderr).slice(0, 400) })
    return refuse('fetch_failed')
  }
  if (!existsSync(join(staging, MANIFEST_FILE))) {
    cleanup()
    return refuse('not_an_agent')
  }
  // The team's `.gitignore` is whatever someone pushed; the kit's rules hold
  // here regardless, from before the folder is ever visible.
  if (!(await ensureAgentExcludes(gitPath, staging, workshopRoot, isCinna(auth)))) {
    cleanup()
    return refuse('failed', 'The ignore rules could not be written.')
  }
  if (existsSync(targetDir)) {
    cleanup()
    return refuse('exists')
  }
  try {
    renameSync(staging, targetDir)
  } catch (err) {
    cleanup()
    return refuse('failed', String(err).slice(0, MAX_DETAIL_CHARS))
  }
  await excludeFromEnclosingRepo(targetDir)
  return done()
}

/**
 * The ignored files and folders in a working tree, relative to it — this
 * machine's own state (`credentials/.env`, `app-data/`), which no clone
 * carries. A wholly ignored directory is one entry, ending in `/`.
 */
export async function ignoredPaths(dir: string): Promise<string[]> {
  const gitPath = await resolveGit()
  if (!gitPath) return []
  const out = await run(
    gitPath,
    dir,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    LOCAL_TIMEOUT_MS
  )
  return out.ok ? lines(out.stdout) : []
}

/** Drop `origin`: the copy Use the team's version keeps is nobody's team agent. */
export async function removeOrigin(dir: string): Promise<boolean> {
  const gitPath = await resolveGit()
  if (!gitPath) return false
  return (await run(gitPath, dir, ['remote', 'remove', 'origin'], LOCAL_TIMEOUT_MS)).ok
}

/**
 * True when the library's head is not in this folder's history — the cheap
 * check the Inbox runs on every read: one `rev-parse`, at most one
 * `merge-base`, no network.
 */
export async function isBehindLibrary(dir: string, libraryHeadSha: string): Promise<boolean> {
  const gitPath = await resolveGit()
  if (!gitPath) return false
  const head = await headOf(gitPath, dir)
  if (head === libraryHeadSha) return false
  if (head === null) return true
  return !(await run(gitPath, dir, ['merge-base', '--is-ancestor', libraryHeadSha, 'HEAD'], LOCAL_TIMEOUT_MS)).ok
}

export const gitService = {
  preflightShare,
  neverTravelPaths,
  restoreLocalOnlyFolders,
  readGitStatus,
  readGitDetail,
  updateGitRepo,
  looksLikeGitRepo,
  readShareRemote,
  setCinnaServer,
  unsetCinnaServer,
  readHistory,
  readShareStatus,
  commitAll,
  pullRebaseClean,
  push,
  shareChanges,
  diffForSummary,
  initWithRemote,
  clone,
  removeOrigin,
  ignoredPaths,
  isBehindLibrary,
  excludeFromEnclosingRepo
}
export type { GitCommit, GitDetail, GitRefusal, GitRemote, GitStatus, GitUpdateResult }
