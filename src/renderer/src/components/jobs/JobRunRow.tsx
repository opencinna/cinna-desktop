import { ExternalLink, MessageSquare, RefreshCw, Inbox, Trash2, AlertTriangle } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { JobRunData, JobRunStatus } from '../../../../shared/jobs'
import { useOpenChatFromRun, useDeleteJobRun } from '../../hooks/useJobs'
import { useRefreshCinnaRun, useCinnaServerUrl } from '../../hooks/useCinna'
import { useShowChatInList } from '../../hooks/useChat'
import { useRelativeNow } from '../../hooks/useRelativeNow'

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

function formatRelative(date: Date, now: Date): string {
  const diff = Math.max(0, now.getTime() - date.getTime())
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function JobRunRow({ run }: JobRunRowProps): React.JSX.Element {
  const openChatFromRun = useOpenChatFromRun()
  const refreshCinna = useRefreshCinnaRun()
  const showChatInList = useShowChatInList()
  const deleteRun = useDeleteJobRun()
  const now = useRelativeNow()
  const tint = STATUS_TINT[run.status]
  const label = STATUS_LABEL[run.status]
  const createdAt = new Date(run.createdAt)
  const [openError, setOpenError] = useState<string | null>(null)
  const [hovering, setHovering] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // Only used for cinna runs; the hook self-gates on `currentUser.type`,
  // so non-cinna profiles never pay for the request.
  const cinnaServerQuery = useCinnaServerUrl()

  const chatGone = run.type === 'local' && !run.localChatId
  const canOpenChat = run.type === 'local' && !!run.localChatId
  const canMoveToChats = canOpenChat && run.chatHidden
  const cinnaUrl =
    run.type === 'cinna_task' && cinnaServerQuery.data && run.cinnaShortCode
      ? `${cinnaServerQuery.data.replace(/\/$/, '')}/tasks/${encodeURIComponent(run.cinnaShortCode)}`
      : null

  const handleOpenCinna = async (): Promise<void> => {
    if (!cinnaUrl) return
    setOpenError(null)
    const res = await window.api.system.openExternal(cinnaUrl)
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

  const rowClickable = canOpenChat
  const handleRowClick = (): void => {
    if (canOpenChat && run.localChatId) openChatFromRun(run.localChatId)
  }

  return (
    <>
    <div
      role={rowClickable ? 'button' : undefined}
      tabIndex={rowClickable ? 0 : undefined}
      onClick={rowClickable ? handleRowClick : undefined}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
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
      title={rowClickable ? 'Open chat' : chatGone ? 'Chat no longer available' : undefined}
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
        <div className="text-xs text-[var(--color-text-secondary)] truncate">
          {run.type === 'cinna_task' && run.cinnaShortCode
            ? `Cinna task ${run.cinnaShortCode}`
            : run.type === 'cinna_task'
              ? 'Cinna task'
              : 'Local chat'}
        </div>
        <div className="text-[10px] text-[var(--color-text-muted)]">
          {formatRelative(createdAt, now)}
          {run.errorMessage ? ` · ${run.errorMessage}` : ''}
          {openError ? ` · ${openError}` : ''}
        </div>
      </div>

      {/*
        Hover-revealed actions. The decorative MessageSquare icon (local) /
        cinna icon buttons (refresh + open external) sit in the right slot
        while idle; on hover they hide and the actionable icons take over so
        the row doesn't get noisy at rest.
      */}
      {!hovering && run.type === 'local' && (
        <span
          aria-hidden
          className={`p-1 text-[var(--color-text-muted)] ${
            rowClickable ? '' : 'opacity-40'
          }`}
        >
          <MessageSquare size={12} />
        </span>
      )}

      {!hovering && run.type === 'cinna_task' && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              refreshCinna.mutate(run.id)
            }}
            disabled={refreshCinna.isPending}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-40"
            title="Refresh status"
          >
            <RefreshCw
              size={12}
              className={refreshCinna.isPending ? 'animate-spin' : undefined}
            />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void handleOpenCinna()
            }}
            disabled={!cinnaUrl}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={cinnaUrl ? 'Open on Cinna' : 'Cinna URL unavailable'}
          >
            <ExternalLink size={12} />
          </button>
        </>
      )}

      {hovering && canMoveToChats && (
        <button
          type="button"
          onClick={handleMoveToChats}
          disabled={showChatInList.isPending}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]
            hover:text-[var(--color-text)] transition-colors disabled:opacity-40 shrink-0"
          title="Move this chat into the Chats list"
          aria-label="Move chat into the Chats list"
        >
          <Inbox size={12} />
        </button>
      )}

      {hovering && (
        <button
          type="button"
          onClick={handleDeleteClick}
          className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)]
            hover:text-[var(--color-danger)] transition-colors shrink-0"
          title="Delete run"
          aria-label="Delete run"
        >
          <Trash2 size={12} />
        </button>
      )}
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
