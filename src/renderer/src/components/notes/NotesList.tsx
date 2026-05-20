import { FolderPlus, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  useCreateNote,
  useCreateNoteFolder,
  useNoteFolders,
  useNoteList,
  useReorderNoteFolders,
  useReorderNotes
} from '../../hooks/useNotes'
import type { NoteData, NoteFolderData } from '../../../../shared/notes'
import { NoteItem } from './NoteItem'
import { NoteFolderRow } from './NoteFolderRow'
import { NoteFolderEditModal } from './NoteFolderEditModal'
import { NotesDragContext, type NotesDrag } from './dragContext'

export function NotesList(): React.JSX.Element {
  const { data: notes, isLoading } = useNoteList()
  const { data: folders } = useNoteFolders()
  const createNote = useCreateNote()
  const createFolder = useCreateNoteFolder()
  const reorderNotes = useReorderNotes()
  const reorderFolders = useReorderNoteFolders()
  const [drag, setDrag] = useState<NotesDrag>(null)
  const [rootAccepting, setRootAccepting] = useState(false)
  // Pop the rename modal immediately after creating a folder — same UX as
  // jobs, so the user lands on the naming step instead of "New folder".
  const [renamingFolder, setRenamingFolder] = useState<NoteFolderData | null>(null)

  const handleAddNote = (): void => {
    if (createNote.isPending) return
    createNote.mutate(undefined)
  }

  const handleAddFolder = (): void => {
    if (createFolder.isPending) return
    createFolder.mutate(
      { name: 'New folder' },
      { onSuccess: (folder) => setRenamingFolder(folder) }
    )
  }

  const groups = useMemo(() => {
    const root: NoteData[] = []
    const byFolder = new Map<string, NoteData[]>()
    for (const note of notes ?? []) {
      if (note.folderId) {
        const arr = byFolder.get(note.folderId) ?? []
        arr.push(note)
        byFolder.set(note.folderId, arr)
      } else {
        root.push(note)
      }
    }
    return { root, byFolder }
  }, [notes])

  const reorderWithinGroup = (
    targetFolderId: string | null,
    draggedNoteId: string,
    beforeNoteId: string | null
  ): void => {
    const existing =
      targetFolderId === null
        ? groups.root
        : (groups.byFolder.get(targetFolderId) ?? [])
    const filtered = existing.filter((n) => n.id !== draggedNoteId)
    const insertAt = beforeNoteId
      ? filtered.findIndex((n) => n.id === beforeNoteId)
      : filtered.length
    const idx = insertAt < 0 ? filtered.length : insertAt
    const newOrder = [
      ...filtered.slice(0, idx).map((n) => n.id),
      draggedNoteId,
      ...filtered.slice(idx).map((n) => n.id)
    ]
    reorderNotes.mutate({ targetFolderId, orderedNoteIds: newOrder })
  }

  const moveNoteToFolder = (
    targetFolderId: string | null,
    draggedNoteId: string
  ): void => {
    reorderWithinGroup(targetFolderId, draggedNoteId, null)
  }

  const reorderFolderList = (
    draggedFolderId: string,
    beforeFolderId: string | null
  ): void => {
    const order = (folders ?? []).map((f) => f.id)
    const filtered = order.filter((id) => id !== draggedFolderId)
    const insertAt = beforeFolderId
      ? filtered.findIndex((id) => id === beforeFolderId)
      : filtered.length
    const idx = insertAt < 0 ? filtered.length : insertAt
    const newOrder = [
      ...filtered.slice(0, idx),
      draggedFolderId,
      ...filtered.slice(idx)
    ]
    reorderFolders.mutate(newOrder)
  }

  // Root drop zone: detach a note from any folder.
  const handleRootDragOver = (e: React.DragEvent): void => {
    if (drag?.kind !== 'note') return
    const draggedNote = (notes ?? []).find((n) => n.id === drag.id)
    if (draggedNote && draggedNote.folderId === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!rootAccepting) setRootAccepting(true)
  }
  const handleRootDragLeave = (): void => {
    if (rootAccepting) setRootAccepting(false)
  }
  const handleRootDrop = (e: React.DragEvent): void => {
    if (drag?.kind !== 'note') return
    e.preventDefault()
    const draggedId = e.dataTransfer.getData('application/x-cinna-note')
    if (draggedId) moveNoteToFolder(null, draggedId)
    setRootAccepting(false)
    setDrag(null)
  }

  return (
    <NotesDragContext.Provider value={{ drag, setDrag }}>
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 pt-1 pb-1">
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
            Notes
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleAddFolder}
              disabled={createFolder.isPending}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
              title="New folder"
            >
              <FolderPlus size={14} />
            </button>
            <button
              onClick={handleAddNote}
              disabled={createNote.isPending}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
              title="New note"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
          ) : !notes || (notes.length === 0 && (folders ?? []).length === 0) ? (
            <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
              No notes yet — click + to create one
            </div>
          ) : (
            <div className="px-1.5 py-1 space-y-0.5">
              {(folders ?? []).map((folder) => (
                <NoteFolderRow
                  key={folder.id}
                  folder={folder}
                  notes={groups.byFolder.get(folder.id) ?? []}
                  onDropNoteInto={(draggedNoteId) =>
                    moveNoteToFolder(folder.id, draggedNoteId)
                  }
                  onReorderInside={(draggedNoteId, beforeNoteId) =>
                    reorderWithinGroup(folder.id, draggedNoteId, beforeNoteId)
                  }
                  onReorderFolder={(draggedFolderId) =>
                    reorderFolderList(draggedFolderId, folder.id)
                  }
                />
              ))}

              <div
                onDragOver={handleRootDragOver}
                onDragLeave={handleRootDragLeave}
                onDrop={handleRootDrop}
                className={`pt-0.5 space-y-px rounded-md ${
                  rootAccepting
                    ? 'ring-1 ring-inset ring-[var(--color-accent)] min-h-[1.5rem]'
                    : ''
                }`}
              >
                {groups.root.map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    onDropNote={(draggedNoteId, beforeNoteId) =>
                      reorderWithinGroup(null, draggedNoteId, beforeNoteId)
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {renamingFolder && (
          <NoteFolderEditModal
            folder={renamingFolder}
            onClose={() => setRenamingFolder(null)}
          />
        )}
      </div>
    </NotesDragContext.Provider>
  )
}
