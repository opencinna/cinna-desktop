import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JobData, JobFolderData } from '../../../../shared/jobs'
import {
  useDeleteJobFolder,
  useExecuteJob,
  useUpdateJobFolder
} from '../../hooks/useJobs'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM } from '../agents/local/OpenInMenu'
import { JobItem } from './JobItem'
import { JobFolderEditModal } from './JobFolderEditModal'
import { useJobsDrag } from './dragContext'

interface JobFolderRowProps {
  folder: JobFolderData
  jobs: JobData[]
  /**
   * Called when a job is dropped on this folder (header or empty body).
   * The parent moves the job into this folder, appended to the end.
   */
  onDropJobInto: (draggedJobId: string) => void
  /**
   * Called when a job is dropped on a specific job inside this folder.
   * The parent reorders the folder's job list, inserting the dragged job
   * before `beforeJobId`.
   */
  onReorderInside: (draggedJobId: string, beforeJobId: string) => void
  /**
   * Called when another folder is dropped on this one. The parent reorders
   * the folder list, inserting the dragged folder before this one.
   */
  onReorderFolder: (draggedFolderId: string) => void
}

/**
 * Sidebar folder row + its contents. Single-click on the header toggles
 * collapse/expand. Hovering the row reveals a ⋯ button in the trailing slot
 * that opens the folder menu: Run All Jobs, then Edit and Delete. Drag-source for folder reorder;
 * drop target for both jobs (move-into) and folders (reorder).
 */
export function JobFolderRow({
  folder,
  jobs,
  onDropJobInto,
  onReorderInside,
  onReorderFolder
}: JobFolderRowProps): React.JSX.Element {
  const updateFolder = useUpdateJobFolder()
  const executeJob = useExecuteJob()
  // Out of the sidebar, beside the folder row like the chat rows' tooltip.
  const menu = usePopover<HTMLButtonElement>('right')
  const [hovering, setHovering] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [acceptingJob, setAcceptingJob] = useState(false)
  const [acceptingFolder, setAcceptingFolder] = useState(false)
  const { drag, setDrag } = useJobsDrag()
  const isDraggingSelf = drag?.kind === 'folder' && drag.id === folder.id

  // The jobs "Run All Jobs" starts: the same set the rows' own run buttons
  // would — not one this device cannot run (main refuses it, and the row
  // already says why), and not one with a run in progress.
  const isRunnable = (j: JobData): boolean => !j.incompleteSetup && j.inProgressRunsCount === 0
  const runnableJobs = jobs.filter(isRunnable)
  // Main does not refuse a second run of a job already running, so each job
  // is checked again against the latest list just before it starts: the user
  // may have pressed its own run button while earlier ones were starting.
  const latestJobs = useRef(jobs)
  latestJobs.current = jobs
  const [runningAll, setRunningAll] = useState(false)
  const runAllLabelId = useId()
  const runAllReasonId = useId()
  // Why Run All Jobs cannot start, said in the item itself (§10, §11).
  const runAllReason = runningAll
    ? 'Already starting the jobs in this folder'
    : runnableJobs.length === 0
      ? jobs.length === 0
        ? 'This folder has no jobs'
        : 'Each job is running or cannot run on this device'
      : null

  // The menu's position is fixed at the moment it opens, so a scroll that
  // moves the row would leave it beside another folder — where Delete would
  // act on one the user can no longer see. Same rule as the chat rows'
  // tooltip: only a scroller that contains the row closes it.
  const { open: menuOpen, setOpen: setMenuOpen, triggerRef: menuTriggerRef } = menu
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: Event): void => {
      if (e.target instanceof Node && !e.target.contains(menuTriggerRef.current)) return
      setMenuOpen(false)
    }
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [menuOpen, setMenuOpen, menuTriggerRef])

  const runAll = async (): Promise<void> => {
    menu.setOpen(false)
    setRunningAll(true)
    // One at a time, in the folder's order, like a quick run of clicks on the
    // rows' run buttons. `navigate: false` keeps the user on the list. A
    // refusal is logged and re-read by the hook's own `onError`, and must not
    // stop the jobs after it.
    for (const { id } of runnableJobs) {
      const job = latestJobs.current.find((j) => j.id === id)
      if (!job || !isRunnable(job)) continue
      try {
        await executeJob.mutateAsync({ jobId: job.id, navigate: false })
      } catch {
        // Reported by useExecuteJob's onError.
      }
    }
    setRunningAll(false)
  }

  const toggleCollapse = (): void => {
    updateFolder.mutate({
      folderId: folder.id,
      patch: { collapsed: !folder.collapsed }
    })
  }

  // ---- drag handlers ------------------------------------------------------

  const handleHeaderDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-cinna-folder', folder.id)
    setDrag({ kind: 'folder', id: folder.id })
  }

  const handleHeaderDragEnd = (): void => {
    setDrag(null)
    setAcceptingJob(false)
    setAcceptingFolder(false)
  }

  const handleHeaderDragOver = (e: React.DragEvent): void => {
    if (drag?.kind === 'job') {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (!acceptingJob) setAcceptingJob(true)
    } else if (drag?.kind === 'folder' && drag.id !== folder.id) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (!acceptingFolder) setAcceptingFolder(true)
    }
  }

  const handleHeaderDragLeave = (): void => {
    setAcceptingJob(false)
    setAcceptingFolder(false)
  }

  const handleHeaderDrop = (e: React.DragEvent): void => {
    if (drag?.kind === 'job') {
      e.preventDefault()
      e.stopPropagation()
      const draggedId = e.dataTransfer.getData('application/x-cinna-job')
      if (draggedId) onDropJobInto(draggedId)
    } else if (drag?.kind === 'folder' && drag.id !== folder.id) {
      e.preventDefault()
      e.stopPropagation()
      const draggedId = e.dataTransfer.getData('application/x-cinna-folder')
      if (draggedId && draggedId !== folder.id) onReorderFolder(draggedId)
    }
    setAcceptingJob(false)
    setAcceptingFolder(false)
    setDrag(null)
  }

  // Empty-body drop zone (visible when folder is expanded and empty) accepts
  // a job and moves it into the folder.
  const handleBodyDragOver = (e: React.DragEvent): void => {
    if (drag?.kind !== 'job') return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (!acceptingJob) setAcceptingJob(true)
  }
  const handleBodyDrop = (e: React.DragEvent): void => {
    if (drag?.kind !== 'job') return
    e.preventDefault()
    e.stopPropagation()
    const draggedId = e.dataTransfer.getData('application/x-cinna-job')
    if (draggedId) onDropJobInto(draggedId)
    setAcceptingJob(false)
    setDrag(null)
  }

  return (
    <div className="space-y-px">
      <div
        draggable
        onDragStart={handleHeaderDragStart}
        onDragEnd={handleHeaderDragEnd}
        onDragOver={handleHeaderDragOver}
        onDragLeave={handleHeaderDragLeave}
        onDrop={handleHeaderDrop}
        onClick={toggleCollapse}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className={`group flex items-center gap-1 px-1.5 py-1 rounded-md cursor-pointer text-[11px] uppercase tracking-wide
          text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]
          transition-colors ${acceptingJob ? 'ring-1 ring-inset ring-[var(--color-accent)]' : ''}
          ${acceptingFolder ? 'border-t-2 border-[var(--color-accent)]' : ''}
          ${isDraggingSelf ? 'opacity-40' : ''}`}
      >
        {folder.collapsed ? (
          <ChevronRight size={12} className="shrink-0" />
        ) : (
          <ChevronDown size={12} className="shrink-0" />
        )}
        <span className="flex-1 truncate normal-case tracking-normal text-xs text-[var(--color-text-secondary)]">
          {folder.name}
        </span>

        {/*
          Trailing slot: job count when idle, ⋯ button on hover or while its
          menu is open. The menu is portaled, so leaving the header for it
          must not close it — only an outside click or picking an item does.
          The button's `stopPropagation` keeps its click from reaching the
          header's collapse toggle; the menu is rendered beside the header,
          not inside it, so its clicks never pass the header at all.
        */}
        <div className="relative w-4 h-4 shrink-0">
          {hovering || menu.open ? (
            <button
              ref={menu.triggerRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                menu.setOpen(!menu.open)
              }}
              aria-haspopup="menu"
              aria-expanded={menu.open}
              className="absolute inset-0 inline-flex items-center justify-center rounded
                text-[var(--color-text-muted)] hover:bg-[var(--color-bg-active)] hover:text-[var(--color-text)]"
              title="Folder actions"
              aria-label="Folder actions"
            >
              <MoreHorizontal size={12} />
            </button>
          ) : (
            <span className="absolute inset-0 inline-flex items-center justify-end text-[10px] text-[var(--color-text-muted)] tabular-nums normal-case tracking-normal">
              {jobs.length}
            </span>
          )}
        </div>
      </div>

      {menu.open &&
        menu.style &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label="Folder actions"
            // A few pixels below the row's top edge, so the menu reads as
            // hanging off the ⋯ rather than level with the folder name.
            style={{ ...menu.style, marginTop: 6 }}
            // The chat rows' tooltip panel: translucent and blurred.
            className="z-50 w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl p-1 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/*
              Unavailable, it stays focusable and says why on a second line —
              a `title` is found by neither a keyboard nor a first pass of the
              pointer. Named by its label, described by the reason.
            */}
            <button
              type="button"
              role="menuitem"
              aria-labelledby={runAllLabelId}
              aria-disabled={runAllReason !== null || undefined}
              aria-describedby={runAllReason ? runAllReasonId : undefined}
              className={`${MENU_ITEM} !items-start ${runAllReason ? 'cursor-not-allowed hover:!bg-transparent' : ''}`}
              onClick={() => {
                if (!runAllReason) void runAll()
              }}
            >
              <Play size={12} className={`mt-0.5 shrink-0 ${runAllReason ? 'opacity-40' : ''}`} />
              <span className="min-w-0">
                <span id={runAllLabelId} className={`block ${runAllReason ? 'opacity-40' : ''}`}>
                  Run All Jobs
                </span>
                {runAllReason && (
                  <span
                    id={runAllReasonId}
                    className="block text-[11px] leading-snug text-[var(--color-text-muted)]"
                  >
                    {runAllReason}
                  </span>
                )}
              </span>
            </button>
            <div className="my-1 border-t border-[var(--color-border)]" />
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                menu.setOpen(false)
                setEditing(true)
              }}
            >
              <Pencil size={12} /> Edit
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${MENU_ITEM} !text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
              onClick={() => {
                menu.setOpen(false)
                setConfirmingDelete(true)
              }}
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>,
          document.body
        )}

      {!folder.collapsed && (
        <div
          className={`pl-3 space-y-px ${
            jobs.length === 0 && acceptingJob
              ? 'min-h-[1.5rem] rounded-md border border-dashed border-[var(--color-accent)]/60'
              : jobs.length === 0
                ? 'min-h-[1.25rem]'
                : ''
          }`}
          onDragOver={handleBodyDragOver}
          onDrop={handleBodyDrop}
        >
          {jobs.map((job) => (
            <JobItem
              key={job.id}
              job={job}
              onDropJob={(draggedJobId, beforeJobId) =>
                onReorderInside(draggedJobId, beforeJobId)
              }
            />
          ))}
          {jobs.length === 0 && (
            <div className="px-2.5 py-1 text-[10px] text-[var(--color-text-muted)] italic">
              Drop a job here
            </div>
          )}
        </div>
      )}

      {editing && (
        <JobFolderEditModal folder={folder} onClose={() => setEditing(false)} />
      )}

      {confirmingDelete && (
        <DeleteFolderConfirm
          folder={folder}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  )
}

interface DeleteFolderConfirmProps {
  folder: JobFolderData
  onClose: () => void
}

function DeleteFolderConfirm({
  folder,
  onClose
}: DeleteFolderConfirmProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const deleteFolder = useDeleteJobFolder()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onMouse = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse)
    }
  }, [onClose])

  return createPortal(
    // Anchored at a fixed top, like the task delete dialog: a line appearing
    // under the buttons lengthens the card downwards and moves neither (§1).
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[20vh]">
      <div
        ref={cardRef}
        className="app-popover-surface w-96 rounded-lg border border-[var(--color-border)] shadow-xl p-5 space-y-4"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-red-400">
          <AlertTriangle size={16} />
          Delete folder
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
          Delete <strong className="text-[var(--color-text)]">{folder.name}</strong>? Any
          jobs inside will be moved back to the top of the jobs list — they are not
          deleted.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              deleteFolder.mutate(folder.id, { onSuccess: () => onClose() })
            }}
            disabled={deleteFolder.isPending}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
          >
            {deleteFolder.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
