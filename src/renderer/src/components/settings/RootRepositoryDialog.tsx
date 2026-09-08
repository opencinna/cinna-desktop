import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DownloadCloud, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { GitCommit, GitRefusal } from '../../../../shared/agentGit'
import type { AgentRootDto } from '../../../../shared/localAgents'
import { useCheckForUpdates, useGitDetail, useUpdateFromGit } from '../../hooks/useLocalAgents'
import { unwrapIpcError } from '../../utils/ipcError'
import { useDialogChrome } from './SettingsLayout'

/**
 * What each refusal means, in the user's words.
 *
 * Every one says the same thing in the end — this is not something Cinna will
 * do for you — because the alternative is a desktop deciding whose work
 * survives a merge in a repository it knows nothing about. Naming the state
 * precisely is what makes that a refusal rather than a shrug.
 *
 * These used to lead with the action because they lived in a two-line clamped
 * row where the tail was cut off. In a dialog they have room, so they read
 * diagnosis-then-action like ordinary prose.
 */
const REFUSAL_TEXT: Record<GitRefusal, string> = {
  not_a_repo: 'This folder is not inside a git working tree.',
  git_missing: 'There is no git on this machine’s PATH. Install git to check for updates.',
  no_upstream:
    'This branch tracks no remote branch, so there is nothing to update from. Set an upstream for it in your own tools.',
  // "this repository", never "here": every git command runs at the repository
  // root, which may be an ancestor of the registered folder.
  dirty:
    'This repository has uncommitted changes, which a fast-forward could overwrite. Commit or discard them first, then check again.',
  diverged:
    'This repository has commits the remote does not. Cinna will not merge or rebase — sort this out in your own tools.',
  fetch_failed:
    'The remote could not be reached. Check your connection and your access to it, then check again.',
  not_fast_forward:
    'The update would not apply cleanly. Cinna only fast-forwards — sort this out in your own tools.'
}

function CommitRow({ commit }: { commit: GitCommit }): React.JSX.Element {
  return (
    <li className="text-[13px] leading-relaxed">
      <span className="font-mono text-[12px] text-[var(--color-text-muted)]">{commit.hash}</span>{' '}
      <span className="text-[var(--color-text)]">{commit.subject}</span>
      <span className="text-[var(--color-text-muted)]">
        {' — '}
        {commit.author}
        {commit.date ? `, ${formatDate(commit.date)}` : ''}
      </span>
    </li>
  )
}

/**
 * An ISO date as the user's own locale renders it.
 *
 * A raw `2024-09-30T11:04:12+02:00` is the one thing on this dialog nobody
 * reads; the point of showing a commit date is "how old is this".
 */
function formatDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="w-24 shrink-0 text-[13px] text-[var(--color-text-muted)]">{label}</span>
      <span className="min-w-0 flex-1 text-[13px] text-[var(--color-text)]">{children}</span>
    </div>
  )
}

/**
 * Everything about a registered folder's repository, on demand.
 *
 * This replaces the branch line that used to sit under every root row. That
 * line was three facts and two controls crammed into a fixed two-line slot: at
 * the 800px minimum window it clipped exactly where its identity was, and the
 * reserved heights that stopped it moving the rows below were a standing tax on
 * every folder, repository or not. A row now carries one button and the detail
 * has as much room as it needs.
 *
 * **Check and Update live here too.** They are the only reason the panel
 * existed, and splitting "what is my repository" from "act on it" across two
 * surfaces would mean the user reads the counts in one place and presses the
 * button in another.
 */
export function RootRepositoryDialog({
  root,
  onClose
}: {
  root: AgentRootDto
  onClose: () => void
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const { data: detail, isLoading } = useGitDetail(root.id, true)
  const check = useCheckForUpdates()
  const update = useUpdateFromGit()
  const [error, setError] = useState<string | null>(null)

  const busy = check.isPending || update.isPending

  useDialogChrome({ modalRef, initialFocusRef: closeRef, pending: busy, onDismiss: onClose })

  // The result of the *last update*, which the status alone cannot express:
  // afterwards `behind` is zero and every count reads like a folder that was
  // never behind at all.
  const applied = update.data?.updated ? update.data.applied : null
  const refusal = detail?.refusal ? REFUSAL_TEXT[detail.refusal] : null
  /*
    `repoRootIsAbove` is decided in main, where both paths go through realpath
    first. Comparing the two strings here made every symlinked location — `/var`
    against `/private/var` on macOS is the everyday one — look like a repository
    above itself, and the dialog named the same directory twice.
  */
  const outerRepo = detail?.repoRootIsAbove ? detail.repoRoot : null

  const openRemote = (url: string): void => {
    setError(null)
    void window.api.system.openExternal(url).then((result) => {
      if (!result.success) setError('That link could not be opened.')
    })
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="root-repository-title"
        className="app-popover-surface flex max-h-[80vh] w-[34rem] flex-col rounded-lg border border-[var(--color-border)] shadow-xl"
      >
        <div className="border-b border-[var(--color-border)] px-5 py-4">
          <div id="root-repository-title" className="text-[14px] font-medium text-[var(--color-text)]">
            Repository
          </div>
          <p className="mt-0.5 truncate font-mono text-[12px] text-[var(--color-text-muted)]" title={root.path}>
            {root.path}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {isLoading || !detail ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              Reading the repository…
            </div>
          ) : !detail.isRepo ? (
            <p className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              {REFUSAL_TEXT[detail.refusal ?? 'not_a_repo']}
            </p>
          ) : (
            <>
              {/*
                Named whenever the repository is *above* the registered folder.
                Every git command runs at its root — `git merge` moves the whole
                working tree — and adopting a directory inside a monorepo is a
                real case. Without this a user pressing Update to move their
                agents folder advanced their entire checkout instead.
              */}
              {outerRepo && (
                <Field label="Inside repository">
                  <span className="font-mono text-[12px] break-all">{outerRepo}</span>
                </Field>
              )}

              {detail.remotes.length === 0 ? (
                <Field label="Remote">
                  <span className="text-[var(--color-text-muted)]">None configured.</span>
                </Field>
              ) : (
                detail.remotes.map((remote) => (
                  <Field key={remote.name} label={remote.name === 'origin' ? 'Remote' : remote.name}>
                    {remote.webUrl ? (
                      <button
                        type="button"
                        onClick={() => openRemote(remote.webUrl as string)}
                        title={remote.url}
                        className="inline-flex max-w-full items-center gap-1 text-left font-medium
                          text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]"
                      >
                        <span className="truncate">{remote.webUrl}</span>
                        <ExternalLink size={12} className="shrink-0" />
                      </button>
                    ) : (
                      // No link for a remote a browser cannot open — a local
                      // path, a relative remote. The raw URL is still the
                      // answer to "where does this come from".
                      <span className="font-mono text-[12px] break-all">{remote.url}</span>
                    )}
                  </Field>
                ))
              )}

              <Field label="Branch">
                <span className="font-mono text-[12px]">{detail.branch ?? 'detached'}</span>
                {detail.upstream && (
                  <span className="text-[var(--color-text-muted)]">
                    {' → '}
                    <span className="font-mono text-[12px]">{detail.upstream}</span>
                  </span>
                )}
              </Field>

              {detail.branches.length > 1 && (
                <Field label="All branches">
                  <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">
                    {detail.branches.join(', ')}
                  </span>
                </Field>
              )}

              <Field label="Latest commit">
                {detail.head ? (
                  <>
                    <span className="font-mono text-[12px] text-[var(--color-text-muted)]">
                      {detail.head.hash}
                    </span>{' '}
                    {detail.head.subject}
                    <span className="block text-[var(--color-text-muted)]">
                      {detail.head.author}
                      {detail.head.date ? `, ${formatDate(detail.head.date)}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-muted)]">
                    No commits in this repository yet.
                  </span>
                )}
              </Field>

              <Field label="Uncommitted">
                <span className={detail.dirty ? 'text-[var(--color-warning)]' : undefined}>
                  {detail.dirty ? 'Yes — this repository has changes' : 'No'}
                </span>
              </Field>

              <div className="border-t border-[var(--color-border)] pt-3">
                <Field label="Updates">
                  {applied ? (
                    `Updated — ${applied.length} commit${applied.length === 1 ? '' : 's'} pulled.`
                  ) : detail.behind > 0 ? (
                    <span className="text-[var(--color-text)]">
                      {detail.behind} update{detail.behind === 1 ? '' : 's'} available
                      {detail.ahead > 0
                        ? `, and ${detail.ahead} local commit${detail.ahead === 1 ? '' : 's'} the remote does not have`
                        : ''}
                      .
                    </span>
                  ) : detail.fetched ? (
                    'Up to date.'
                  ) : (
                    'Up to date as of the last check.'
                  )}
                </Field>

                {refusal && (
                  <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-warning)]">
                    {refusal}
                  </p>
                )}

                {(applied ?? detail.incoming).length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-[13px] text-[var(--color-text-muted)]">
                      {applied ? 'What changed' : 'What is waiting'}
                    </div>
                    <ul className="max-h-40 space-y-0.5 overflow-y-auto border-l-2 border-[var(--color-border)] pl-2.5">
                      {(applied ?? detail.incoming).map((commit) => (
                        <CommitRow key={commit.hash} commit={commit} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-5 py-4">
          {/* Reserved, so a refusal does not move the buttons (ux_rules rule 1). */}
          <div role="alert" className="min-h-[3.25rem] text-[13px] leading-relaxed text-[var(--color-danger)]">
            {error}
          </div>
          <div className="flex justify-end gap-2">
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium
                text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]
                disabled:opacity-50"
            >
              Close
            </button>
            {/*
              Hidden for the two refusals a check cannot move. With no upstream
              and with no git installed, `readGitStatus` returns before it ever
              fetches, so the button spun and then changed nothing at all — not
              even the refusal, which was already on screen (ux_rules rule 6).
            */}
            {detail?.isRepo &&
              detail.refusal !== 'no_upstream' &&
              detail.refusal !== 'git_missing' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError(null)
                    check.mutate(root.id, {
                      onError: (err) =>
                        setError(unwrapIpcError(err, 'Could not check for updates.'))
                    })
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)]
                    bg-[var(--color-bg-secondary)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-text)]
                    transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
                >
                  <RefreshCw size={13} className={check.isPending ? 'animate-spin' : undefined} />
                  {check.isPending ? 'Checking…' : 'Check for updates'}
                </button>
              )}
            {/*
              Only when there is something to apply and nothing standing in its
              way: an Update button that always refuses is a button that teaches
              the user to expect a refusal.
            */}
            {detail?.isRepo && detail.behind > 0 && detail.refusal === null && (
              <button
                type="button"
                disabled={busy}
                title={
                  outerRepo
                    ? `Fast-forward the repository at ${outerRepo}`
                    : 'Fast-forward this folder'
                }
                onClick={() => {
                  setError(null)
                  update.mutate(root.id, {
                    onError: (err) =>
                      setError(unwrapIpcError(err, 'Could not update that folder.'))
                  })
                }}
                className="inline-flex min-w-[6.5rem] items-center justify-center gap-1.5 rounded-md
                  bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white
                  transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              >
                <DownloadCloud size={13} />
                {update.isPending ? 'Updating…' : 'Update'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
