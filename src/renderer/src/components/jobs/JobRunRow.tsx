import {
  ExternalLink,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Inbox,
  Trash2,
  AlertTriangle
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { JobRunData, JobRunStatus } from '../../../../shared/jobs'
import { useOpenChatFromRun, useDeleteJobRun } from '../../hooks/useJobs'
import { useRefreshCinnaRun, useCinnaServerUrl } from '../../hooks/useCinna'
import { useOpenExternal } from '../../hooks/useSystem'
import { useCinnaTaskView } from '../../hooks/useCinnaTaskView'
import { useShowChatInList } from '../../hooks/useChat'
import { useOpenTask } from '../../hooks/useTasks'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useUIStore } from '../../stores/ui.store'
import { createLogger } from '../../stores/logger.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { formatRelativeFromDate } from '../../utils/cinnaTime'
import { isContentComment } from '../../../../shared/cinnaTaskView'

const log = createLogger('job-run-row')
const MIN_SPIN_MS = 500

interface JobRunRowProps {
  run: JobRunData
}

const STATUS_TINT: Record<JobRunStatus, string> = {
  pending: 'text-[var(--color-text-muted)] bg-[var(--color-bg-hover)]',
  running: 'text-[var(--color-severity-info-text)] bg-[var(--color-severity-info)]/15',
  succeeded: 'text-[var(--color-severity-ok-text)] bg-[var(--color-severity-ok)]/15',
  failed: 'text-[var(--color-severity-error-text)] bg-[var(--color-severity-error)]/15',
  cancelled: 'text-[var(--color-text-muted)] bg-[var(--color-bg-hover)]'
}

const STATUS_LABEL: Record<JobRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled'
}


export function JobRunRow({ run }: JobRunRowProps): React.JSX.Element {
  const openChatFromRun = useOpenChatFromRun()
  const refreshCinna = useRefreshCinnaRun()
  const openExternal = useOpenExternal()
  const showChatInList = useShowChatInList()
  const deleteRun = useDeleteJobRun()
  const openTask = useOpenTask()
  const setActiveCinnaRunId = useUIStore((s) => s.setActiveCinnaRunId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const now = useRelativeNow()
  const tint = STATUS_TINT[run.status]
  const label = STATUS_LABEL[run.status]
  const createdAt = new Date(run.createdAt)
  const [openError, setOpenError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [refreshSpinning, setRefreshSpinning] = useState(false)

  // Only used for cinna runs; the hook self-gates on `currentUser.type`,
  // so non-cinna profiles never pay for the request.
  const cinnaServerQuery = useCinnaServerUrl()

  const chatGone = run.type === 'local' && !run.localChatId
  const canOpenChat = run.type === 'local' && !!run.localChatId
  const canOpenCinnaView = run.type === 'cinna_task' && !!run.cinnaTaskId
  const canMoveToChats = canOpenChat && run.chatHidden
  /**
   * **The row opens the task, not the chat.** A task outlives the chat it ran
   * in — which is hidden from the Chats list, and can be deleted with the run —
   * so it is the record of the work and the one thing that is still there
   * afterwards (§5.8 of the agent runtime plan: "the run row's link target
   * changes to the task view"). The conversation stays one click away, as its
   * own labelled action.
   *
   * Runs that predate the tasks table have no `taskId` and keep exactly the
   * behaviour they had; so does a `cinna_task` run, which does not create a
   * task until step 11 folds that path onto the task adapter.
   */
  const canOpenTask = !!run.taskId

  // Cinna rows show comment/attachment count badges. Polling is disabled
  // here so N visible rows don't trigger N /detail fetches every 5s; the
  // detail view polls on its own subscription and shares the same query
  // key + cache. Disabled for non-cinna rows or rows without a cinnaTaskId.
  const taskViewQuery = useCinnaTaskView(canOpenCinnaView ? run.cinnaTaskId : null, {
    polling: false
  })
  const counts = taskViewQuery.data
    ? {
        comments: taskViewQuery.data.comments.filter(isContentComment).length,
        attachments: taskViewQuery.data.attachments.length
      }
    : null
  const cinnaUrl =
    run.type === 'cinna_task' && cinnaServerQuery.data && run.cinnaShortCode
      ? `${cinnaServerQuery.data.replace(/\/$/, '')}/tasks/${encodeURIComponent(run.cinnaShortCode)}`
      : null

  const handleOpenCinna = async (): Promise<void> => {
    if (!cinnaUrl) return
    setOpenError(null)
    const res = await openExternal(cinnaUrl)
    if (!res.success) setOpenError(res.error)
  }

  const handleMoveToChats = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!run.localChatId || showChatInList.isPending) return
    showChatInList.mutate(run.localChatId)
  }

  const handleDeleteClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setConfirming(true)
  }

  const handleConfirmDelete = (): void => {
    deleteRun.mutate(
      { jobId: run.jobId, runId: run.id },
      {
        onSuccess: () => setConfirming(false),
        onError: () => setConfirming(false)
      }
    )
  }

  const rowClickable = canOpenTask || canOpenChat || canOpenCinnaView
  const handleRowClick = (): void => {
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

  const handleOpenChatClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (run.localChatId) openChatFromRun(run.localChatId)
  }

  const handleOpenCinnaViewClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setActiveCinnaRunId(run.id)
    setActiveView('cinna-task-run')
  }

  const handleRefreshClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    log.info('manual cinna run refresh', { runId: run.id, status: run.status })
    setRefreshSpinning(true)
    const startedAt = Date.now()
    refreshCinna.mutate(
      { runId: run.id, force: true },
      {
        onError: (err) =>
          log.warn('cinna run refresh failed', {
            runId: run.id,
            // The log overlay is the only surface this failure reaches — the
            // spinner just stops. The entry already carries its scope, so the
            // channel name the wrapper prepends adds nothing.
            error: unwrapIpcError(err, 'The run could not be refreshed.')
          }),
        onSettled: () => {
          const elapsed = Date.now() - startedAt
          const wait = Math.max(0, MIN_SPIN_MS - elapsed)
          window.setTimeout(() => setRefreshSpinning(false), wait)
        }
      }
    )
  }

  return (
    <>
    <div
      role={rowClickable ? 'button' : undefined}
      tabIndex={rowClickable ? 0 : undefined}
      onClick={rowClickable ? handleRowClick : undefined}
      onKeyDown={
        rowClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleRowClick()
              }
            }
          : undefined
      }
      title={
        canOpenTask
          ? 'Open the task'
          : canOpenChat
            ? 'Open chat'
            : canOpenCinnaView
              ? 'Open task view'
              : chatGone
                ? 'Chat no longer available'
                : undefined
      }
      className={`group flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] transition-colors ${
        rowClickable
          ? 'cursor-pointer hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-muted)]'
          : ''
      }`}
    >
      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${tint}`}>
        {label}
      </span>
      {chatGone && (
        <span
          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium
            text-[var(--color-text-muted)] bg-[var(--color-bg-hover)]"
          title="The chat that ran this job was deleted"
        >
          <Trash2 size={10} />
          Deleted
        </span>
      )}
      <div className="flex-1 min-w-0">
        {/*
          **The row names what it opens.** It said "Local chat" while its
          tooltip and its destination had both become the task — a control that
          names the thing it no longer opens (`ux_rules.md` §10, and its
          accessible name carried the same wrong word). The task's own title is
          deliberately not used: for a job run it is the job's title, which is
          the heading directly above this list, and a sub-line that repeats the
          title says nothing (§7).
        */}
        <div className="text-xs text-[var(--color-text-secondary)] truncate">
          {run.type === 'cinna_task' && run.cinnaShortCode
            ? `Cinna task ${run.cinnaShortCode}`
            : run.type === 'cinna_task'
              ? 'Cinna task'
              : canOpenTask
                ? 'Task'
                : 'Local chat'}
        </div>
        <div className="text-[10px] text-[var(--color-text-muted)]">
          {formatRelativeFromDate(createdAt, now)}
          {run.errorMessage ? ` · ${run.errorMessage}` : ''}
          {openError ? ` · ${openError}` : ''}
        </div>
      </div>

      {counts && (counts.comments > 0 || counts.attachments > 0) && (
        <div className="flex items-center gap-1 shrink-0">
          {counts.comments > 0 && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold
                bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)]"
              title={`${counts.comments} comment${counts.comments === 1 ? '' : 's'}`}
            >
              <MessageSquare size={10} />
              {counts.comments}
            </span>
          )}
          {counts.attachments > 0 && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold
                bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)]"
              title={`${counts.attachments} attachment${counts.attachments === 1 ? '' : 's'}`}
            >
              <Paperclip size={10} />
              {counts.attachments}
            </span>
          )}
        </div>
      )}

      {/*
        **The conversation is a labelled control, not a hover reveal.** The row
        itself now opens the task, so this is the only route from Run history to
        the chat — and putting it in the hover strip below replaced a
        discoverable way in with an invisible one: `ux_rules.md` §11 is explicit
        that a control whose only distinction appears on `:hover` does not exist
        for anyone who has not already guessed it is there. So it sits outside
        that wrapper, at rest, with its name on it.

        Only on rows that lead somewhere else first. A run with no task still
        opens its chat when the row is clicked, and a second control for the
        thing the row already does would be noise.
      */}
      {canOpenTask && canOpenChat && (
        <button
          type="button"
          onClick={handleOpenChatClick}
          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded
            text-[10px] font-medium text-[var(--color-accent)]
            hover:bg-[var(--color-bg-hover)] transition-colors"
          title="Open the conversation this run happened in"
        >
          <MessageSquare size={11} />
          Chat
        </button>
      )}

      {/*
        The same rule, for the service's own conversation.

        Step 11 gave a run that executes on a service a task, and `canOpenTask`
        is checked first — so this row's click moved from the service's run view
        to the task page, which is §5.8's "the run row's link target changes to
        the task view". The service's view is the only screen in the app that
        renders the *conversation* over there, and the task page does not; a
        change that silently made it unreachable would take a surface away
        rather than replace one.

        So it is named, at rest, and for the same reason step 6's UX review gave
        for Chat: a control nobody can find is a control that does not exist.

        **It is never beside Chat**, which is worth saying because the shape
        suggests otherwise: `canOpenChat` requires `type === 'local'` and
        `canOpenCinnaView` requires `'cinna_task'`, so no run can offer both.
        The two are the same idea — "the conversation this run happened in" —
        for the two places a run can happen, and a row shows whichever one it
        has.

        **It is not called "Conversation", and the reason is a collision one
        click wide.** The task page's own header button says *Open the
        conversation* and opens the **local chat**; this one opens the thread on
        the service. Two controls, one noun, two destinations, for the same task
        (`ux_rules.md` §10). The label names *where* instead, which is the one
        thing that actually distinguishes them.
      */}
      {canOpenTask && canOpenCinnaView && (
        <button
          type="button"
          onClick={handleOpenCinnaViewClick}
          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded
            text-[10px] font-medium text-[var(--color-accent)]
            hover:bg-[var(--color-bg-hover)] transition-colors"
          title="Open the conversation in the service that ran this"
        >
          <MessageSquare size={11} />
          On the service
        </button>
      )}

      {/* Action icons reveal on row hover (focus-within keeps them reachable
          for keyboard users). Cinna runs get Refresh + Open external +
          Delete; local runs get Move-to-Chats (when the spawned chat is
          still hidden) + Delete. */}
      <div className="flex items-center gap-2 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {run.type === 'cinna_task' && (
        <>
          <button
            type="button"
            onClick={handleRefreshClick}
            disabled={refreshSpinning || refreshCinna.isPending}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-40 shrink-0"
            title="Refresh status"
            aria-label="Refresh status"
          >
            <RefreshCw
              size={16}
              className={refreshSpinning || refreshCinna.isPending ? 'animate-spin' : undefined}
            />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void handleOpenCinna()
            }}
            disabled={!cinnaUrl}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            title={cinnaUrl ? 'Open on Cinna' : 'Cinna URL unavailable'}
            aria-label="Open on Cinna"
          >
            <ExternalLink size={16} />
          </button>
        </>
      )}

      {canMoveToChats && (
        <button
          type="button"
          onClick={handleMoveToChats}
          disabled={showChatInList.isPending}
          className="p-1 rounded hover:bg-[var(--color-accent)]/20 text-[var(--color-text-muted)]
            hover:text-[var(--color-accent)] transition-colors disabled:opacity-40 shrink-0"
          title="Move this chat into the Chats list"
          aria-label="Move chat into the Chats list"
        >
          <Inbox size={16} />
        </button>
      )}

      <button
        type="button"
        onClick={handleDeleteClick}
        className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)]
          hover:text-[var(--color-danger)] transition-colors shrink-0"
        title="Delete run"
        aria-label="Delete run"
      >
        <Trash2 size={16} />
      </button>
      </div>
    </div>
    {confirming && (
      <DeleteRunConfirm
        run={run}
        pending={deleteRun.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={handleConfirmDelete}
      />
    )}
    </>
  )
}

interface DeleteRunConfirmProps {
  run: JobRunData
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Confirmation modal for permanently deleting a job run. For local runs the
 * originating chat is deleted alongside the run — copy is explicit about that
 * so the user doesn't lose conversation history they wanted to keep. For
 * cinna_task runs only the desktop's bookkeeping is removed; the upstream
 * cinna-core task stays on the server.
 *
 * Mirrors `DeleteJobConfirm` (in JobItem.tsx) for visual consistency:
 * portal-rendered overlay, ESC + outside-click dismiss, red confirm button.
 */
function DeleteRunConfirm({
  run,
  pending,
  onCancel,
  onConfirm
}: DeleteRunConfirmProps): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    const onClick = (e: MouseEvent): void => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onCancel])

  const isLocal = run.type === 'local'
  const chatGoneAlready = isLocal && !run.localChatId

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        className="app-popover-surface w-96 rounded-lg border border-[var(--color-border)] shadow-xl p-5 space-y-4"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-red-400">
          <AlertTriangle size={16} />
          Delete run
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
          {isLocal && !chatGoneAlready ? (
            <>
              Delete this run? The chat it spawned will be{' '}
              <strong className="text-[var(--color-text)]">permanently deleted</strong>{' '}
              along with it — this can't be undone.
            </>
          ) : isLocal ? (
            <>
              Delete this run? The originating chat is already gone, so only the run
              record itself will be removed.
            </>
          ) : (
            <>
              Delete this run? Only the desktop's run record is removed — the upstream
              Cinna task stays on the server.
            </>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
