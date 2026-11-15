import { FolderPlus, Plus } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import {
  useCreateNote,
  useCreateNoteFolder,
  useNoteCollections,
  useNoteFolders,
  useReorderNoteFolders,
  useReorderNotes
} from '../../hooks/useNotes'
import type { NoteData, NoteFolderData } from '../../../../shared/notes'
import { NoteItem } from './NoteItem'
import { NoteFolderRow } from './NoteFolderRow'
import { NoteFolderEditModal } from './NoteFolderEditModal'
import { NotesDragContext, type NotesDrag } from './dragContext'
import { MemoryNotesSection } from './MemoryNotesSection'
import { NoteTagFilterButton, NoteTagFilterRow } from './NoteTagFilter'
import { useUIStore } from '../../stores/ui.store'
import { noteIdsForTag, noteTags, tagFilterChips, type NoteTagRow } from '../../utils/noteFormat/noteIndex'

export function NotesList(): React.JSX.Element {
  // Regular notes fill the folders; Assistant memory notes get their own
  // section after them.
  const { regular: notes, memory, isLoading } = useNoteCollections()
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

  // Tags of the regular notes (frontmatter `tags` + inline `#tags`), derived
  // from the bodies in memory, and the filter they offer.
  const tagFilter = useUIStore((s) => s.notesTagFilter)
  const activeNoteId = useUIStore((s) => s.activeNoteId)
  const activeView = useUIStore((s) => s.activeView)
  const keptOpenRef = useRef<{ filter: string; id: string } | null>(null)
  const setTagFilter = useUIStore((s) => s.setNotesTagFilter)
  const tagRows = useMemo<NoteTagRow[]>(
    () => notes.flatMap((note) => noteTags(note.body).map((tag) => ({ noteId: note.id, ...tag }))),
    [notes]
  )
  const chips = useMemo(() => tagFilterChips(tagRows), [tagRows])
  const filtered = useMemo(() => {
    if (!tagFilter) return null
    const ids = noteIdsForTag(tagRows, tagFilter)
    // An open note that matched keeps its row while it stays open, even once
    // its tag is edited away: a row vanishing under the user's typing is a
    // jump. A note that never matched is not added.
    const open = activeView === 'note-detail' ? activeNoteId : null
    const kept = keptOpenRef.current
    if (open && ids.has(open)) keptOpenRef.current = { filter: tagFilter, id: open }
    else if (!kept || kept.filter !== tagFilter || kept.id !== open) keptOpenRef.current = null
    const keep = keptOpenRef.current?.id ?? null
    return notes.filter((note) => ids.has(note.id) || note.id === keep)
  }, [notes, tagRows, tagFilter, activeNoteId, activeView])
  const filterDisplay = tagFilter ? (chips.find((c) => c.key === tagFilter)?.display ?? tagFilter) : null

  const handleAddNote = (): void => {
    if (createNote.isPending) return
    // The new note has no tag: show the whole list, where its row will be.
    setTagFilter(null)
    createNote.mutate(undefined)
  }

  const handleAddFolder = (): void => {
    if (createFolder.isPending) return
    setTagFilter(null)
    createFolder.mutate(
      { name: 'New folder' },
      { onSuccess: (folder) => setRenamingFolder(folder) }
    )
  }

  const groups = useMemo(() => {
    const root: NoteData[] = []
    const byFolder = new Map<string, NoteData[]>()
    for (const note of notes) {
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
    const draggedNote = notes.find((n) => n.id === drag.id)
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
            {/* Leftmost, so the buttons beside it never move as it comes and goes. */}
            {chips.length > 0 && (
              <NoteTagFilterButton chips={chips} active={tagFilter} onPick={setTagFilter} />
            )}
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
        {filterDisplay !== null && (
          <NoteTagFilterRow display={filterDisplay} onClear={() => setTagFilter(null)} />
        )}

        <div className="app-scroll-fade flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
          ) : filtered ? (
            filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
                No notes tagged #{filterDisplay}
              </div>
            ) : (
              <div className="px-1.5 py-1 space-y-px">
                {filtered.map((note) => (
                  <NoteItem key={note.id} note={note} draggable={false} />
                ))}
              </div>
            )
          ) : notes.length === 0 && memory.length === 0 && (folders ?? []).length === 0 ? (
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

              <MemoryNotesSection notes={memory} />
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
