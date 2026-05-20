import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useDeleteNote } from '../../hooks/useNotes'
import type { NoteData } from '../../../../shared/notes'
import { useNotesDrag } from './dragContext'

interface NoteItemProps {
  note: NoteData
  /**
   * Called when another note is dropped on top of this row. The parent
   * (folder or root container) translates that into a reorder within its
   * own group — see NotesList / NoteFolderRow.
   */
  onDropNote?: (draggedNoteId: string, beforeNoteId: string) => void
}

export function NoteItem({ note, onDropNote }: NoteItemProps): React.JSX.Element {
  const activeNoteId = useUIStore((s) => s.activeNoteId)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveNoteId = useUIStore((s) => s.setActiveNoteId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const deleteNote = useDeleteNote()
  const [hovering, setHovering] = useState(false)
  const [dropTarget, setDropTarget] = useState(false)
  const { drag, setDrag } = useNotesDrag()

  const isActive = activeNoteId === note.id && activeView === 'note-detail'

  const canAcceptDrop =
    !!onDropNote && drag?.kind === 'note' && drag.id !== note.id
  const isDraggingSelf = drag?.kind === 'note' && drag.id === note.id

  const handleDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-cinna-note', note.id)
    // Force the sidebar surface color so the browser-native drag preview
    // doesn't paint white outside the row's rounded radius. Same trick as
    // JobItem.
    ;(e.currentTarget as HTMLElement).style.backgroundColor =
      'var(--color-bg-secondary)'
    setDrag({ kind: 'note', id: note.id })
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
    if (!canAcceptDrop || !onDropNote) return
    e.preventDefault()
    e.stopPropagation()
    const draggedId = e.dataTransfer.getData('application/x-cinna-note')
    if (draggedId && draggedId !== note.id) {
      onDropNote(draggedId, note.id)
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
      onClick={() => {
        setActiveNoteId(note.id)
        setActiveView('note-detail')
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-md cursor-pointer text-xs transition-colors ${
        isActive
          ? 'app-nav-active text-[var(--color-text)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
      } ${dropTarget ? 'ring-1 ring-inset ring-[var(--color-accent)]' : ''} ${
        isDraggingSelf ? 'opacity-40' : ''
      }`}
    >
      <span className="flex-1 truncate">{note.title || 'Untitled note'}</span>
      {hovering && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            deleteNote.mutate(note.id)
          }}
          className="p-0.5 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors shrink-0"
          title="Delete note"
          aria-label="Delete note"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
