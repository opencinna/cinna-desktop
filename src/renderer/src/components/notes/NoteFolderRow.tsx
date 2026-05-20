import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Settings,
  Pencil,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NoteData, NoteFolderData } from '../../../../shared/notes'
import { useDeleteNoteFolder, useUpdateNoteFolder } from '../../hooks/useNotes'
import { NoteItem } from './NoteItem'
import { NoteFolderEditModal } from './NoteFolderEditModal'
import { useNotesDrag } from './dragContext'

interface NoteFolderRowProps {
  folder: NoteFolderData
  notes: NoteData[]
  onDropNoteInto: (draggedNoteId: string) => void
  onReorderInside: (draggedNoteId: string, beforeNoteId: string) => void
  onReorderFolder: (draggedFolderId: string) => void
}

export function NoteFolderRow({
  folder,
  notes,
  onDropNoteInto,
  onReorderInside,
  onReorderFolder
}: NoteFolderRowProps): React.JSX.Element {
  const updateFolder = useUpdateNoteFolder()
  const [hovering, setHovering] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [acceptingNote, setAcceptingNote] = useState(false)
  const [acceptingFolder, setAcceptingFolder] = useState(false)
  const { drag, setDrag } = useNotesDrag()
  const isDraggingSelf = drag?.kind === 'folder' && drag.id === folder.id

  const toggleCollapse = (): void => {
    updateFolder.mutate({
      folderId: folder.id,
      patch: { collapsed: !folder.collapsed }
    })
  }

  const handleHeaderDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-cinna-note-folder', folder.id)
    setDrag({ kind: 'folder', id: folder.id })
  }

  const handleHeaderDragEnd = (): void => {
    setDrag(null)
    setAcceptingNote(false)
    setAcceptingFolder(false)
  }

  const handleHeaderDragOver = (e: React.DragEvent): void => {
    if (drag?.kind === 'note') {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (!acceptingNote) setAcceptingNote(true)
    } else if (drag?.kind === 'folder' && drag.id !== folder.id) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (!acceptingFolder) setAcceptingFolder(true)
    }
  }

  const handleHeaderDragLeave = (): void => {
    setAcceptingNote(false)
    setAcceptingFolder(false)
  }

  const handleHeaderDrop = (e: React.DragEvent): void => {
    if (drag?.kind === 'note') {
      e.preventDefault()
      e.stopPropagation()
      const draggedId = e.dataTransfer.getData('application/x-cinna-note')
      if (draggedId) onDropNoteInto(draggedId)
    } else if (drag?.kind === 'folder' && drag.id !== folder.id) {
      e.preventDefault()
      e.stopPropagation()
      const draggedId = e.dataTransfer.getData('application/x-cinna-note-folder')
      if (draggedId && draggedId !== folder.id) onReorderFolder(draggedId)
    }
    setAcceptingNote(false)
    setAcceptingFolder(false)
    setDrag(null)
  }

  const handleBodyDragOver = (e: React.DragEvent): void => {
    if (drag?.kind !== 'note') return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (!acceptingNote) setAcceptingNote(true)
  }
  const handleBodyDrop = (e: React.DragEvent): void => {
    if (drag?.kind !== 'note') return
    e.preventDefault()
    e.stopPropagation()
    const draggedId = e.dataTransfer.getData('application/x-cinna-note')
    if (draggedId) onDropNoteInto(draggedId)
    setAcceptingNote(false)
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
          transition-colors ${acceptingNote ? 'ring-1 ring-inset ring-[var(--color-accent)]' : ''}
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
              {notes.length}
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
            notes.length === 0 && acceptingNote
              ? 'min-h-[1.5rem] rounded-md border border-dashed border-[var(--color-accent)]/60'
              : notes.length === 0
                ? 'min-h-[1.25rem]'
                : ''
          }`}
          onDragOver={handleBodyDragOver}
          onDrop={handleBodyDrop}
        >
          {notes.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              onDropNote={(draggedNoteId, beforeNoteId) =>
                onReorderInside(draggedNoteId, beforeNoteId)
              }
            />
          ))}
          {notes.length === 0 && (
            <div className="px-2.5 py-1 text-[10px] text-[var(--color-text-muted)] italic">
              Drop a note here
            </div>
          )}
        </div>
      )}

      {editing && (
        <NoteFolderEditModal folder={folder} onClose={() => setEditing(false)} />
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
  folder: NoteFolderData
  onClose: () => void
}

function DeleteFolderConfirm({
  folder,
  onClose
}: DeleteFolderConfirmProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const deleteFolder = useDeleteNoteFolder()

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
          notes inside will be moved back to the top of the notes list — they are not
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
