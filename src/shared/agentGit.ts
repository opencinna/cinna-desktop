/**
 * The git state of an agents folder, as the renderer sees it.
 *
 * Shared rather than main-private because the preload bridge and the settings
 * panel both name these types, and neither may import from `src/main`.
 * `src/main/services/localAgents/gitService.ts` is what produces them, and its
 * docstring is where the reasoning about what this feature will and will not do
 * lives — in short: it fast-forwards, and it never resolves a conflict.
 */

/** One commit, as the update panel shows it. */
export interface GitCommit {
  /** Short hash, as `git log` abbreviates it. */
  hash: string
  subject: string
  author: string
  /** ISO-8601 author date. */
  date: string
}

/**
 * Why an update cannot be applied. A **code**, so the renderer picks the
 * sentence and the tests do not assert on prose.
 *
 * - `not_a_repo` — the folder is not inside a git working tree.
 * - `git_missing` — no `git` on this machine's `PATH`.
 * - `no_upstream` — the branch tracks nothing, or the head is detached.
 * - `dirty` — uncommitted changes; a fast-forward could overwrite them.
 * - `diverged` — local commits the remote does not have. Fast-forward is not
 *   possible and merging is not this app's job.
 * - `fetch_failed` — the remote could not be reached or refused the request.
 * - `not_fast_forward` — the merge itself refused; the state changed under us
 *   between the check and the update.
 */
export type GitRefusal =
  | 'not_a_repo'
  | 'git_missing'
  | 'no_upstream'
  | 'dirty'
  | 'diverged'
  | 'fetch_failed'
  | 'not_fast_forward'

/** What a folder's repository looks like right now. */
export interface GitStatus {
  /** False for every other field's purposes: nothing else is meaningful. */
  isRepo: boolean
  /** Absolute path of the working tree root — may be above the folder asked about. */
  repoRoot: string | null
  branch: string | null
  /** e.g. `origin/main`, or null when the branch tracks nothing. */
  upstream: string | null
  /** Commits the local branch has that the upstream does not. */
  ahead: number
  /** Commits the upstream has that the local branch does not. */
  behind: number
  /** Uncommitted changes, tracked files only — untracked files do not block a fast-forward. */
  dirty: boolean
  /** The commits behind, newest first, capped at {@link MAX_COMMITS}. */
  incoming: GitCommit[]
  /** Set when this folder cannot be updated, and why. Null when it can. */
  refusal: GitRefusal | null
  /** Whether the counts came from a `fetch` just now or from the last one. */
  fetched: boolean
}

/** What one update attempt did. */
export interface GitUpdateResult {
  /** True when the working tree moved. */
  updated: boolean
  /** The commits that were applied, newest first. Empty when nothing moved. */
  applied: GitCommit[]
  refusal: GitRefusal | null
  /** The status as it is *after* the attempt, so the panel needs no refetch. */
  status: GitStatus
}
