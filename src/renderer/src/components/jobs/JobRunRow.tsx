import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, MoreHorizontal, Trash2 } from 'lucide-react'
import type { JobRunData, JobRunStatus } from '../../../../shared/jobs'
import type { TaskStatus } from '../../../../shared/taskStatus'
import { useDeleteJobRun, useOpenChatFromRun } from '../../hooks/useJobs'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
import { unwrapIpcError } from '../../utils/ipcError'
import { useOpenTask } from '../../hooks/useTasks'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useUIStore } from '../../stores/ui.store'
import { formatChatDuration, formatChatStarted } from '../../utils/chatSummaryFormat'
import { TaskStatusIcon } from '../tasks/TaskStatusIcon'

interface JobRunRowProps {
  run: JobRunData
}

/** The run's status as the task vocabulary `TaskStatusIcon` draws. */
const ICON_STATUS: Record<JobRunStatus, TaskStatus> = {
  pending: 'new',
  running: 'in_progress',
  succeeded: 'completed',
  failed: 'error',
  cancelled: 'cancelled'
}

/**
 * One run of a job, as a row in the job page's Tasks history — the Inbox's
 * task row, told apart by **when** rather than by title.
 *
 * Every task a job creates carries the job's title, the heading directly above
 * this list, so a title column would say the same thing on every row. What
 * tells the runs apart is when each started, and how long it took; where it
 * stands is the icon leading the row, and the word is in its accessible name
 * (`ux_rules.md` §10).
 *
 * For a run whose task is live the row is the only control. The run's
 * occasional actions — moving its chat into the Chats list, deleting it with
 * its chat — are on the task's page, in its ⋯ menu, which is where the row
 * leads. A run whose task is gone has no such page: it opens its chat (or the
 * service's run view) and carries Delete run in a ⋯ of its own. A run with
 * nothing to open is not a button.
 *
 * The duration is last and appears only once the run has finished, so it is
 * the one part of the row that can arrive later: nothing sits after it for it
 * to push (§1).
 */
export function JobRunRow({ run }: JobRunRowProps): React.JSX.Element {
  const openTask = useOpenTask()
  const openChatFromRun = useOpenChatFromRun()
  const setActiveCinnaRunId = useUIStore((s) => s.setActiveCinnaRunId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const now = useRelativeNow()

  const startedAt = new Date(run.startedAt ?? run.createdAt)
  const started = formatChatStarted(startedAt, now)
  // Only once the run is over: a running or pending run has no duration yet,
  // and a live "under a minute" reads as a finished one.
  const finished = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
  const duration = finished && run.finishedAt
    ? formatChatDuration(Math.max(0, new Date(run.finishedAt).getTime() - startedAt.getTime()))
    : null
  const statusWord = run.status
  /*
    Where it stands, and for a failure why — the error lives in the icon's
    `title`, which nests inside the row's button and so is not in its name
    (`ux_rules.md` §10). "‹start› — failed: ‹error›".
  */
  const standing = run.errorMessage ? `${statusWord}: ${run.errorMessage}` : statusWord

  /**
   * **The task first.** A task outlives the chat it ran in — hidden from the
   * Chats list, deleted with the run — so it is the record of the work (§5.8 of
   * the agent runtime plan). Runs with no task keep what they did before: a
   * local run opens its chat, a cinna run the service's run view.
   */
  const canOpenTask = !!run.taskId && run.taskLive
  /*
    Orphaned: its task is gone — never made (a legacy run), or deleted, maybe
    on another device, since runs do not sync. With no task page to hold
    Delete, the row carries it in its own ⋯.
  */
  const orphaned = !run.taskLive
  const canOpenChat = hasOwnChat(run)
  const canOpenCinnaView = run.type === 'cinna_task' && !!run.cinnaTaskId
  const clickable = canOpenTask || canOpenChat || canOpenCinnaView
  const handleClick = (): void => {
    if (canOpenTask && run.taskId) {
      openTask(run.taskId)
      return
    }
    if (canOpenChat && run.localChatId) {
      openChatFromRun(run.localChatId)
      return
    }
    if (canOpenCinnaView) {
      setActiveCinnaRunId(run.id)
      setActiveView('cinna-task-run')
    }
  }

  /*
    Said in the row, not only in a tooltip: a row that does nothing when
    clicked has to say so to someone who has not hovered it (§10, §11).
  */
  const unopenableReason = clickable
    ? null
    : run.type === 'local'
      ? 'Chat deleted'
      : 'Nothing to open'

  const durationEl = duration && (
    <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">{duration}</span>
  )
  /** Everything before the duration — an orphan row puts its ⋯ between the two. */
  const lead = (
    <>
      <span
        className="flex shrink-0 items-center"
        title={run.errorMessage ? `${statusWord} — ${run.errorMessage}` : statusWord}
      >
        <TaskStatusIcon status={ICON_STATUS[run.status]} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text)]">{started}</span>
      {unopenableReason && (
        <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{unopenableReason}</span>
      )}
    </>
  )
  const content = (
    <>
      {lead}
      {durationEl}
    </>
  )
  const rowClass = 'w-full flex items-center gap-2.5 rounded px-2 py-1 leading-5 text-left'

  if (orphaned) {
    /*
      Siblings in one row box, never a button inside a button: the part that
      opens, then ⋯, then the duration. Same outer width, left edge, padding
      and gaps as a normal row, and the duration stays flush right in the same
      column, so the ⋯ is the only thing an orphan adds (§1). Always visible
      (§11).
    */
    return (
      <div className={`${rowClass} !py-0 ${clickable ? 'hover:bg-[var(--color-bg-hover)]' : ''}`}>
        {clickable ? (
          <button
            type="button"
            onClick={handleClick}
            aria-label={`${started} — ${standing}`}
            title={canOpenChat ? 'Open chat' : 'Open task view'}
            className="flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left"
          >
            {lead}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5 py-1">
            {lead}
            <span className="sr-only"> — {standing}</span>
          </div>
        )}
        <RunActionsMenu run={run} />
        {durationEl}
      </div>
    )
  }
  if (!clickable) {
    return (
      <div className={rowClass}>
        {content}
        <span className="sr-only"> — {standing}</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      /*
        When and where it stands, with a failure's reason. The duration is left out: while the run goes
        it rewrites itself every half-minute, and a name that changes under a
        screen reader is worse than one that omits what the row shows.
      */
      aria-label={`${started} — ${standing}`}
      title={canOpenTask ? 'Open the task' : canOpenChat ? 'Open chat' : 'Open task view'}
      className={`${rowClass} hover:bg-[var(--color-bg-hover)]`}
    >
      {content}
    </button>
  )
}

/**
 * The ⋯ of a run whose task is gone: Delete run, the one action it has left.
 * The mutation lives here, beside the dialog, and not in the dialog, so a
 * failure can keep the dialog open with its reason (§5, §6); on success the
 * run leaves the list and this row with it.
 */
/**
 * Whether the run has a chat of its own — the one Delete run removes. Only a
 * local run does, the rule `jobRunChatId` applies in main.
 */
function hasOwnChat(run: JobRunData): boolean {
  return run.type === 'local' && !!run.localChatId
}

function RunActionsMenu({ run }: { run: JobRunData }): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleteRun = useDeleteJobRun()
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={() => menu.setOpen(!menu.open)}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label="Run actions"
        title="Run actions"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded
          text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-active)] hover:text-[var(--color-text)] transition-colors"
      >
        <MoreHorizontal size={14} />
      </button>
      {menu.open &&
        menu.style &&
        createPortal(
          <div ref={menu.popoverRef} role="menu" aria-label="Run actions" style={menu.style} className={MENU_SURFACE}>
            <button
              type="button"
              role="menuitem"
              // `!`: in the built CSS the plain danger class loses to MENU_ITEM's own colour.
              className={`${MENU_ITEM} !text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
              onClick={() => {
                menu.setOpen(false)
                setError(null)
                setConfirming(true)
              }}
            >
              <Trash2 size={12} />
              Delete run…
            </button>
          </div>,
          document.body
        )}
      {confirming && (
        <DeleteRunDialog
          hasChat={hasOwnChat(run)}
          pending={deleteRun.isPending}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setError(null)
            deleteRun.mutate(
              { jobId: run.jobId, runId: run.id },
              {
                onSuccess: () => setConfirming(false),
                onError: (err) => setError(unwrapIpcError(err, 'The run could not be deleted.'))
              }
            )
          }}
        />
      )}
    </>
  )
}

/**
 * Confirm Delete run: the job stays, the run — and its chat, when it has one —
 * are gone for good. The same top-anchored shell as the other delete dialogs,
 * undismissable while pending, the failure last and below the buttons.
 */
function DeleteRunDialog({
  hasChat,
  pending,
  error,
  onCancel,
  onConfirm
}: {
  hasChat: boolean
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !pendingRef.current) onCancel()
    }
    const onClick = (e: MouseEvent): void => {
      if (pendingRef.current) return
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onCancel])
  const permanently = <strong className="text-[var(--color-text)]">permanently deleted</strong>
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[20vh]">
      <div
        ref={modalRef}
        role="dialog"
        aria-label="Delete run"
        className="app-popover-surface w-96 space-y-4 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]">
          <AlertTriangle size={16} />
          Delete run
        </div>
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
          The job stays.{' '}
          {hasChat ? <>This run and the chat it ran in are {permanently}</> : <>This run is {permanently}</>}{' '}
          — this can&apos;t be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="min-w-[6rem] rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
        {error && (
          <div role="alert" className="text-[11px] leading-relaxed text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
