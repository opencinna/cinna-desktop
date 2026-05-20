import { AlertTriangle, ChevronDown, ChevronRight, Settings, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JobData, JobFolderData } from '../../../../shared/jobs'
import {
  useDeleteJobFolder,
  useUpdateJobFolder
} from '../../hooks/useJobs'
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
 * collapse/expand. Hovering the row reveals a gear icon on the left of the
 * header that opens an Edit/Delete popover. Drag-source for folder reorder;
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
  const [hovering, setHovering] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [acceptingJob, setAcceptingJob] = useState(false)
  const [acceptingFolder, setAcceptingFolder] = useState(false)
  const { drag, setDrag } = useJobsDrag()
  const isDraggingSelf = drag?.kind === 'folder' && drag.id === folder.id

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
        onMouseLeave={() => {
          setHovering(false)
          if (!confirmingDelete && !editing) setMenuOpen(false)
        }}
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
          Trailing slot: job count when idle, gear button on hover. The gear
          opens an inline Edit/Delete menu (Pencil/Trash2). `stopPropagation`
          keeps the toggle from bubbling up to the header collapse handler.
        */}
        <div className="relative w-4 h-4 shrink-0">
          {hovering || menuOpen ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen((v) => !v)
              }}
              className="absolute inset-0 inline-flex items-center justify-center rounded
                text-[var(--color-text-muted)] hover:bg-[var(--color-bg-active)] hover:text-[var(--color-text)]"
              title="Folder actions"
              aria-label="Folder actions"
            >
              <Settings size={12} />
            </button>
          ) : (
            <span className="absolute inset-0 inline-flex items-center justify-end text-[10px] text-[var(--color-text-muted)] tabular-nums normal-case tracking-normal">
              {jobs.length}
            </span>
          )}
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 z-30 min-w-[8rem] rounded-md
                border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg py-1"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setEditing(true)
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] normal-case tracking-normal"
              >
                <Pencil size={12} /> Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setConfirmingDelete(true)
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-red-400 hover:bg-[var(--color-bg-hover)] normal-case tracking-normal"
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
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
