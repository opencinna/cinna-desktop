import { useState } from 'react'
import { ChevronDown, ChevronRight, DownloadCloud, RefreshCw } from 'lucide-react'
import { useCheckForUpdates, useGitStatus, useUpdateFromGit } from '../../hooks/useLocalAgents'
import type { GitCommit, GitRefusal } from '../../../../shared/agentGit'
import type { AgentRootDto } from '../../../../shared/localAgents'
import { unwrapIpcError } from '../../utils/ipcError'

/**
 * What each refusal means, in the user's words.
 *
 * Every one of them says the same thing in the end — this is not something
 * Cinna will do for you — because the alternative is a desktop deciding whose
 * work survives a merge in a repository it knows nothing about. Naming the
 * state precisely is what makes that a refusal rather than a shrug.
 *
 * **Each one leads with the action, not the diagnosis.** The status line is one
 * reserved, truncating row — the same shape, for the same reason, as the Runs
 * with panel's — so at the 800px minimum window the second half of a long
 * sentence is not on screen. Written diagnosis-first ("There are uncommitted
 * changes here. Commit or discard them…") the half that survives is the half
 * the user cannot act on. The full sentence is always in the row's `title`.
 */
/**
 * The block's frame, shared by the loading state and the settled one so their
 * heights are the same by construction rather than by a matching magic number.
 */
const BLOCK = 'mt-1.5 border-t border-[var(--color-border)] pt-1.5'
const BRANCH_LINE = 'truncate font-mono text-[10px] text-[var(--color-text-muted)]'
/**
 * Two reserved lines, not one truncating line.
 *
 * The refusals are two sentences, and at the 800px minimum window (`minWidth`
 * in `src/main/index.ts`) a single truncating line cut ~87px off the end —
 * losing "…then check again" and leaving the user a diagnosis with no action
 * (ux_rules rule 7). Rewording them action-first fixed which half survives;
 * reserving the second line means neither half has to be sacrificed. The height
 * is fixed rather than growing on demand, so a refusal arriving after a click
 * on Check does not push the rows below the card down (rule 1). The full text is
 * still in `title` for anything longer than two lines.
 */
const STATUS_LINE = 'line-clamp-2 h-[1.75rem] text-[10px] leading-[0.875rem]'
const DISCLOSURE_SLOT = 'min-h-[1.125rem]'

const REFUSAL_TEXT: Record<GitRefusal, string> = {
  not_a_repo: '',
  git_missing: 'Install git to check for updates.',
  no_upstream: 'Set an upstream for this branch — it tracks no remote branch to update from.',
  // **"this repository", never "here" or "this folder".** Every git command
  // runs at the repository root, which may be an ancestor of the registered
  // folder — adopting a directory inside a monorepo is a real case. A user told
  // their *agents folder* has uncommitted changes, when the edit is elsewhere
  // in a checkout they have never associated with Cinna, goes looking in the
  // wrong directory.
  //
  // Kept short enough to fit the two reserved lines at the 800px minimum —
  // measured, not estimated. A refusal that clamps is back to losing its tail.
  dirty: 'Commit or discard this repository’s changes first, then check again.',
  diverged: 'Sort this out in your own tools — this repository has commits the remote does not.',
  fetch_failed: 'Check your connection and your access — the remote could not be reached.',
  not_fast_forward: 'Sort this out in your own tools — the update would not apply cleanly.'
}

function CommitList({ commits, title }: { commits: GitCommit[]; title: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // No top margin: the caller reserves this row's height whether or not there
  // is a list, and a margin only on the present state would put the difference
  // back into the layout.
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {title}
      </button>
      {open && (
        <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto border-l-2 border-[var(--color-border)] pl-2">
          {commits.map((commit) => (
            <li key={commit.hash} className="text-[10px] text-[var(--color-text-secondary)]">
              <span className="font-mono text-[var(--color-text-muted)]">{commit.hash}</span>{' '}
              <span className="text-[var(--color-text)]">{commit.subject}</span>
              <span className="text-[var(--color-text-muted)]"> — {commit.author}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The update line under one agents folder that is a git working tree.
 *
 * **Renders nothing at all when the folder is not a repository**, which is the
 * common case and the reason this is not a banner: a settings row that told
 * every user "not a git repository" would be a line of noise on every install
 * for a feature most of them will never use (ux_rules rule 2).
 *
 * It reads the *cached* counts on open and fetches only when Check is pressed,
 * because this renders once per registered root and a network round trip per
 * root on every visit to Settings is not something the user asked for.
 *
 * The panel sits below everything else in the row, so a status line arriving
 * after a check cannot move the buttons the user is about to press
 * (ux_rules rule 1).
 */
export function AgentsRootGit({ root }: { root: AgentRootDto }): React.JSX.Element | null {
  // `root.isGitRepo` is a cheap stat walk done in main and carried on the root,
  // so a folder that is not a repository renders nothing from the first frame
  // and never asks git at all. Discovering that from the query instead meant
  // every root drew, then either grew a block or did not — pushing the rows
  // below it by 44px on the first visit (ux_rules rule 1).
  const gitLikely = root.exists && root.isGitRepo
  const { data: status, isLoading } = useGitStatus(root.id, gitLikely)
  const check = useCheckForUpdates()
  const update = useUpdateFromGit()
  const [error, setError] = useState<string | null>(null)

  // The result of the *last update*, which the status alone cannot express:
  // afterwards `behind` is zero and every count reads like a folder that was
  // never behind at all.
  const applied = update.data?.updated ? update.data.applied : null

  if (!gitLikely) return null
  // While the real answer is in flight, render the block's **frame** with empty
  // content rather than a guessed height: two lines in the left column and the
  // reserved disclosure strip, from the same classes the settled block uses, so
  // the two cannot drift apart and the rows below never move (ux_rules rule 1).
  if (isLoading) {
    return (
      <div className={BLOCK} aria-hidden>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className={BRANCH_LINE}>&nbsp;</div>
            <div className={`${STATUS_LINE} text-[var(--color-text-muted)]`}>&nbsp;</div>
          </div>
          <div className="h-[22px] w-[5.5rem] shrink-0" />
        </div>
        <div className={DISCLOSURE_SLOT} />
      </div>
    )
  }
  // The stat walk was optimistic — a `.git` above a folder that git itself does
  // not treat as a working tree. Nothing to show, and the collapse is invisible
  // because there is nothing below it in this row.
  if (!status || !status.isRepo) return null

  const busy = check.isPending || update.isPending
  /**
   * The repository root, when it is **not** the registered folder.
   *
   * Every git command runs there — `git merge` moves the whole working tree, so
   * pretending otherwise would be worse — and adopting a directory inside a
   * monorepo is a real case. Without naming it, this panel showed a branch, an
   * upstream, a commit list and an Update button, all true of a repository
   * whose identity was the one thing withheld: a user pressing Update to move
   * their agents folder advanced their entire checkout instead.
   */
  const outerRepo = status.repoRoot && status.repoRoot !== root.path ? status.repoRoot : null
  /**
   * The repository's **name**, not its path.
   *
   * Appended to a truncating line, a path loses its tail — which is the only
   * part that identifies it, the same way it did on the adopt dialog's picked
   * path. The basename always fits, is what the user recognises, and the row
   * directly above already shows the adopted folder's full path, so the
   * relationship between the two is on screen. The full path is in `title`.
   */
  const outerRepoName = outerRepo?.split(/[\\/]/).filter(Boolean).pop() ?? null
  const refusal = status.refusal ? REFUSAL_TEXT[status.refusal] : ''
  const behind = status.behind

  const line = refusal
    ? refusal
    : applied
      ? `Updated — ${applied.length} commit${applied.length === 1 ? '' : 's'} pulled.`
      : behind > 0
        ? `${behind} update${behind === 1 ? '' : 's'} available.`
        : status.fetched
          ? 'Up to date.'
          : 'Up to date as of the last check.'

  return (
    <div className={BLOCK}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className={BRANCH_LINE} title={outerRepo ?? undefined}>
            {status.branch ?? 'detached'}
            {status.upstream ? ` → ${status.upstream}` : ''}
            {outerRepoName ? ` · repository: ${outerRepoName}` : ''}
          </div>
          <div
            className={`${STATUS_LINE} ${
              refusal
                ? 'text-[var(--color-warning)]'
                : behind > 0 || applied
                  ? 'text-[var(--color-text-secondary)]'
                  : 'text-[var(--color-text-muted)]'
            }`}
            title={line}
          >
            {line}
          </div>
        </div>
        {/*
          Hidden for the two refusals a check cannot move. With no upstream and
          with no git installed, `readGitStatus` returns before it ever fetches,
          so the button spun and then changed nothing at all — not even the
          refusal, which was already on screen. That is the same button this
          file refuses to render for Update ("a button that always refuses is a
          button that teaches the user to expect a refusal"), minus even the
          refusal: it teaches that the control does nothing (ux_rules rule 6).
          Neither state can change without the user editing the repository or
          the machine, and the query refetches on focus when they have.
        */}
        {status.refusal !== 'no_upstream' && status.refusal !== 'git_missing' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null)
              check.mutate(root.id, {
                onError: (err) => setError(unwrapIpcError(err, 'Could not check for updates.'))
              })
            }}
            className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-40"
            title="Check the remote for updates"
            aria-label={`Check ${root.label} for updates`}
          >
            <RefreshCw size={13} className={check.isPending ? 'animate-spin' : undefined} />
          </button>
        )}
        {/*
          A fixed slot, always present, so pressing Check cannot move Check.
          It used to appear beside Check and shift it 77px left — putting the
          freshly-rendered **Update** button under the pointer that had just
          clicked Check, where an impatient second click is a `git pull`
          (ux_rules rule 1). Wide enough for "Updating…", which is the longest
          the label gets.

          Only filled when there is something to apply and nothing standing in
          its way: an Update button that always refuses is a button that teaches
          the user to expect a refusal.
        */}
        <div className="flex w-[5.5rem] shrink-0 justify-end">
          {behind > 0 && status.refusal === null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null)
                update.mutate(root.id, {
                  onError: (err) => setError(unwrapIpcError(err, 'Could not update that folder.'))
                })
              }}
              // The label stays "Update" rather than growing to "Update the
              // repository": the slot is a fixed width precisely so pressing
              // Check cannot move Check, and a label whose width depended on
              // the root would reintroduce that at first paint. The scope is
              // stated where the user reads it — on the line above, and here.
              title={
                outerRepo
                  ? `Fast-forward the repository at ${outerRepo}`
                  : 'Fast-forward this folder'
              }
              className="flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
            >
              <DownloadCloud size={11} />
              {update.isPending ? 'Updating…' : 'Update'}
            </button>
          )}
        </div>
      </div>
      {/*
        The disclosure's row is reserved whether or not there is a list, because
        it appears in answer to a *click on Check* and everything below it — the
        "Add an agents folder" button, the Readiness card, its "Start engine"
        button — moved 19px down when it did (ux_rules rule 1). A blank strip on
        an up-to-date repository costs nothing; the same strip appearing under a
        pointer that has just clicked does not. Expanding the list does grow the
        block, and that is fine: it is a disclosure the user opened.
      */}
      <div className={DISCLOSURE_SLOT}>
        {applied && applied.length > 0 ? (
          <CommitList commits={applied} title={`What changed (${applied.length})`} />
        ) : !applied && behind > 0 && status.incoming.length > 0 ? (
          <CommitList commits={status.incoming} title={`What is waiting (${status.incoming.length})`} />
        ) : null}
      </div>
      {error && <div className="mt-1 text-[10px] text-[var(--color-danger)]">{error}</div>}
    </div>
  )
}
