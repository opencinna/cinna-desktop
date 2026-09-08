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
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  GitCommit,
  GitRefusal,
  GitStatus,
  GitUpdateResult
} from '../../../shared/agentGit'
import { getShellEnv, shellEnvForChild, which } from '../../shell/env'
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
  timeout: number
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
    LC_ALL: 'C'
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

async function resolveGit(): Promise<string | null> {
  return which('git')
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

export const gitService = { readGitStatus, updateGitRepo, looksLikeGitRepo }
export type { GitCommit, GitRefusal, GitStatus, GitUpdateResult }
