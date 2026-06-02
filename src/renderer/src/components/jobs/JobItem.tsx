import { AlertTriangle, Loader2, Play } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore } from '../../stores/ui.store'
import { useExecuteJob } from '../../hooks/useJobs'
import type { JobData } from '../../../../shared/jobs'
import { useJobsDrag } from './dragContext'

interface JobItemProps {
  job: JobData
  /**
   * Called when another job is dropped on top of THIS row. The parent (folder
   * or root container) is responsible for translating that into a reorder
   * within its own group — see JobsList / JobFolderRow.
   */
  onDropJob?: (draggedJobId: string, beforeJobId: string) => void
}

export function JobItem({ job, onDropJob }: JobItemProps): React.JSX.Element {
  const activeJobId = useUIStore((s) => s.activeJobId)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const executeJob = useExecuteJob()
  const [hovering, setHovering] = useState(false)
  const [dropTarget, setDropTarget] = useState(false)
  const { drag, setDrag } = useJobsDrag()
  // Highlight while the user is anywhere in this job's context — its detail
  // view, edit page, OR the chat view spawned/opened from one of its runs
  // (activeJobId is preserved across that handoff so the sidebar reflects
  // "you're still working inside this job").
  const isActive =
    activeJobId === job.id &&
    (activeView === 'job-detail' || activeView === 'job-edit' || activeView === 'chat')

  // The mutation's `isPending` covers the click-through latency (server
  // create + stream-start); `inProgressRunsCount` covers the rest of the
  // run lifecycle until the stream's `done` event invalidates `['jobs']`.
  // OR-ing them avoids a flicker between the two windows.
  const isRunning = executeJob.isPending || job.inProgressRunsCount > 0

  const handleRunNow = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (isRunning) return
    // navigate=false: fire-and-forget from the sidebar so the user can kick
    // off multiple jobs without losing their place in the list.
    executeJob.mutate({ jobId: job.id, navigate: false })
  }

  // Only accept a `job` drag from a different job — folder drags don't drop
  // onto job rows, and re-dropping onto self is a no-op.
  const canAcceptDrop =
    !!onDropJob && drag?.kind === 'job' && drag.id !== job.id

  // Row is the currently-dragged source — dim it so the user sees what's
  // moving even though the browser-native drag preview is suppressed.
  const isDraggingSelf = drag?.kind === 'job' && drag.id === job.id

  const handleDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-cinna-job', job.id)
    // Chromium rasterizes the row's bounding box for the drag preview, so any
    // pixels OUTSIDE the rounded-radius come out as the row's background. The
    // idle row is transparent, which paints white in the light theme and
    // makes the preview look like a square with rounded inset. Force the
    // sidebar surface color (matches what's behind the row anyway) for the
    // duration of the drag so the preview blends in and looks rounded.
    ;(e.currentTarget as HTMLElement).style.backgroundColor =
      'var(--color-bg-secondary)'
    setDrag({ kind: 'job', id: job.id })
  }

  const handleDragEnd = (e: React.DragEvent): void => {
    setDrag(null)
    setDropTarget(false)
    ;(e.currentTarget as HTMLElement).style.backgroundColor = ''
  }

  const handleDragOver = (e: React.DragEvent): void => {
    if (!canAcceptDrop) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (!dropTarget) setDropTarget(true)
  }

  const handleDragLeave = (): void => {
    if (dropTarget) setDropTarget(false)
  }

  const handleDrop = (e: React.DragEvent): void => {
    if (!canAcceptDrop || !onDropJob) return
    e.preventDefault()
    e.stopPropagation()
    const draggedId = e.dataTransfer.getData('application/x-cinna-job')
    if (draggedId && draggedId !== job.id) {
      onDropJob(draggedId, job.id)
    }
    setDropTarget(false)
    setDrag(null)
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-md cursor-pointer text-xs transition-colors ${
        isActive
          ? 'app-nav-active text-[var(--color-text)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
      } ${dropTarget ? 'ring-1 ring-inset ring-[var(--color-accent)]' : ''} ${
        isDraggingSelf ? 'opacity-40' : ''
      }`}
      onClick={() => {
        setActiveJobId(job.id)
        setActiveView('job-detail')
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="flex-1 truncate">{job.title}</span>
      {/*
        "Finish setup" indicator for a job that synced from another device with
        a dependency not yet resolved here. Suppressed while running (the run
        spinner takes the trailing slot) and while hovering an idle row (the
        run-now button does).
      */}
      {job.needsSetup && !isRunning && !hovering && (
        <span
          className="inline-flex items-center justify-center w-4 h-4 shrink-0 text-[var(--color-warning)]"
          title="A dependency needs setup on this device"
          aria-label="Needs setup"
        >
          <AlertTriangle size={11} />
        </span>
      )}
      {/*
        Running state takes precedence and is shown UNCONDITIONALLY (not gated
        on hover) so the user can scan the sidebar at a glance for in-progress
        jobs. Idle state only shows the run-now button on hover so resting
        rows stay clean.
      */}
      {/*
        Fixed 16x16 trailing slot so the row height never changes between
        idle (empty), hover (play button), and running (spinner) states. The
        Play button itself is the same 16x16 box (no extra padding), with
        the Play glyph centered inside via flex.
      */}
      {isRunning ? (
        <span
          className="inline-flex items-center justify-center w-4 h-4 shrink-0 text-[var(--color-success)]"
          title="A run of this job is in progress"
          aria-label="Running"
        >
          <Loader2 size={12} className="animate-spin" />
        </span>
      ) : (
        hovering && (
          <button
            type="button"
            onClick={handleRunNow}
            className="inline-flex items-center justify-center w-4 h-4 rounded
              bg-[var(--color-success)] hover:brightness-110 text-white
              transition-all shrink-0"
            title="Run this job"
            aria-label="Run this job"
          >
            <Play size={10} />
          </button>
        )
      )}
    </div>
  )
}

interface DeleteJobConfirmProps {
  jobTitle: string
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Standard delete-job confirmation modal. Exported so other surfaces (e.g.
 * the JobDetail header's delete button) can reuse the same dialog.
 */
export function DeleteJobConfirm({
  jobTitle,
  pending,
  onCancel,
  onConfirm
}: DeleteJobConfirmProps): React.JSX.Element {
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

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        className="app-popover-surface w-96 rounded-lg border border-[var(--color-border)] shadow-xl p-5 space-y-4"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-red-400">
          <AlertTriangle size={16} />
          Delete job
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
          Delete <strong className="text-[var(--color-text)]">{jobTitle}</strong>? The job's
          run history is kept on disk but the job itself will be removed from the sidebar.
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
