import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  NoteAttachAsFilesInputDto,
  NoteCreateInputDto,
  NoteData,
  NotePatchDto,
  NoteFolderCreateInputDto,
  NoteFolderPatchDto
} from '../../../shared/notes'
import type { MessageAttachment } from '../../../shared/attachments'
import { useUIStore } from '../stores/ui.store'

export function useNoteList() {
  return useQuery({
    queryKey: ['notes'],
    queryFn: () => window.api.notes.list()
  })
}

export function useNote(noteId: string | null) {
  return useQuery({
    queryKey: ['notes', noteId],
    queryFn: () => (noteId ? window.api.notes.get(noteId) : null),
    enabled: !!noteId
  })
}

/**
 * Imperative single-note fetch for event handlers (e.g. the chat composer's
 * `?` double-Enter expansion). Routes through the same `['notes', id]` cache
 * key as {@link useNote} so a previously previewed note hits cache instead
 * of re-roundtripping to the main process.
 */
export function useFetchNote(): (noteId: string) => Promise<NoteData> {
  const queryClient = useQueryClient()
  return useCallback(
    (noteId: string) =>
      queryClient.fetchQuery({
        queryKey: ['notes', noteId],
        queryFn: () => window.api.notes.get(noteId)
      }),
    [queryClient]
  )
}

export function useCreateNote() {
  const queryClient = useQueryClient()
  const setActiveNoteId = useUIStore((s) => s.setActiveNoteId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  return useMutation({
    mutationFn: (input?: NoteCreateInputDto) =>
      window.api.notes.create(input ?? { title: 'Untitled note', body: '' }),
    onSuccess: (note) => {
      queryClient.invalidateQueries({ queryKey: ['notes'] })
      setActiveNoteId(note.id)
      setActiveView('note-detail')
    }
  })
}

export function useUpdateNote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ noteId, patch }: { noteId: string; patch: NotePatchDto }) =>
      window.api.notes.update(noteId, patch),
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: ['notes'] })
      queryClient.invalidateQueries({ queryKey: ['notes', noteId] })
    }
  })
}

/**
 * Soft-delete (move to trash). Notes in the trash are restorable and are
 * permanently dropped after 30 days on startup. Mirrors the chat flow.
 */
export function useDeleteNote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (noteId: string) => window.api.notes.delete(noteId),
    onSuccess: (_data, noteId) => {
      const ui = useUIStore.getState()
      if (ui.activeNoteId === noteId) {
        ui.setActiveNoteId(null)
      }
      // Drop the deleted note's individual cache before invalidating the list,
      // otherwise the still-mounted `useNote(deletedId)` observer refetches
      // synchronously (before the active-note clear has re-rendered) and the
      // main process logs a `not_found` for the soft-deleted row.
      queryClient.removeQueries({ queryKey: ['notes', noteId] })
      queryClient.invalidateQueries({ queryKey: ['notes'] })
      queryClient.invalidateQueries({ queryKey: ['notes-trash'] })
    }
  })
}

export function useNotesTrash() {
  return useQuery({
    queryKey: ['notes-trash'],
    queryFn: () => window.api.notes.trashList()
  })
}

export function useRestoreNote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (noteId: string) => window.api.notes.restore(noteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] })
      queryClient.invalidateQueries({ queryKey: ['notes-trash'] })
    }
  })
}

export function usePermanentDeleteNote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (noteId: string) => window.api.notes.permanentDelete(noteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes-trash'] })
    }
  })
}

export function useEmptyNotesTrash() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.notes.emptyTrash(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes-trash'] })
    }
  })
}

// ---- Folders --------------------------------------------------------------

export function useNoteFolders() {
  return useQuery({
    queryKey: ['note-folders'],
    queryFn: () => window.api.noteFolders.list()
  })
}

export function useCreateNoteFolder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: NoteFolderCreateInputDto) =>
      window.api.noteFolders.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['note-folders'] })
    }
  })
}

export function useUpdateNoteFolder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      folderId,
      patch
    }: {
      folderId: string
      patch: NoteFolderPatchDto
    }) => window.api.noteFolders.update(folderId, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['note-folders'] })
    }
  })
}

export function useDeleteNoteFolder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (folderId: string) => window.api.noteFolders.delete(folderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['note-folders'] })
      // Notes inside the folder were detached to the root.
      queryClient.invalidateQueries({ queryKey: ['notes'] })
    }
  })
}

export function useReorderNotes() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      targetFolderId,
      orderedNoteIds
    }: {
      targetFolderId: string | null
      orderedNoteIds: string[]
    }) => window.api.notes.reorder(targetFolderId, orderedNoteIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] })
    }
  })
}

// ---- Inline-edit autosave -------------------------------------------------

const AUTOSAVE_DEBOUNCE_MS = 500

/** Empty / whitespace-only titles are normalized to this label before save. */
export const FALLBACK_TITLE = 'Untitled note'

export interface AutosaveNoteHandle {
  title: string
  body: string
  setTitle: (value: string) => void
  setBody: (value: string) => void
  /**
   * Immediately persist pending edits (skips the debounce). Idempotent — a
   * no-op when local state already matches the last-persisted snapshot.
   */
  flushNow: () => void
}

/**
 * Inline-edit autosave for a single note. Owns the local title/body state,
 * tracks the last-persisted snapshot, debounces while the user is typing,
 * and flushes pending edits to the *previous* note when the user switches
 * notes (so unsaved changes never get stranded on the wrong row).
 *
 * Pass `null` while the note is loading; the hook will reset internal state
 * on the next non-null `note.id` it sees.
 */
export function useAutosaveNote(note: NoteData | null | undefined): AutosaveNoteHandle {
  const updateNote = useUpdateNote()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  // Last-persisted values for the *currently active* note id. Compared to
  // the live state to decide whether autosave actually has work to do.
  const snapshotRef = useRef<{ title: string; body: string }>({ title: '', body: '' })
  // The note id local state currently reflects. When this drifts from
  // `note.id`, the cross-note flush effect catches up.
  const lastNoteIdRef = useRef<string | null>(null)

  const normalize = (raw: string): string => (raw.trim() ? raw : FALLBACK_TITLE)

  // Persist pending edits attributed to whichever note id local state
  // *currently* reflects (not the one that just came in via props). Used by
  // both the cross-note switch flow and `flushNow`.
  const persist = useCallback(
    (noteId: string, nextTitle: string, nextBody: string) => {
      const finalTitle = normalize(nextTitle)
      updateNote.mutate(
        { noteId, patch: { title: finalTitle, body: nextBody } },
        {
          onSuccess: () => {
            // Only update the snapshot if the snapshot still belongs to the
            // same note we just saved against — otherwise we'd clobber the
            // freshly-loaded snapshot for a different note.
            if (lastNoteIdRef.current === noteId) {
              snapshotRef.current = { title: finalTitle, body: nextBody }
            }
          }
        }
      )
    },
    [updateNote]
  )

  // Cross-note switch: flush any pending edit attributed to the OLD note
  // (using the in-memory local state), then reseed local state from the
  // NEW note. Skips the flush on the very first mount.
  useEffect(() => {
    if (!note) return
    if (lastNoteIdRef.current === note.id) return
    if (lastNoteIdRef.current !== null) {
      const prevId = lastNoteIdRef.current
      const snap = snapshotRef.current
      if (title !== snap.title || body !== snap.body) {
        persist(prevId, title, body)
      }
    }
    lastNoteIdRef.current = note.id
    setTitle(note.title)
    setBody(note.body)
    snapshotRef.current = { title: note.title, body: note.body }
    // Only react to id changes; title/body in deps would cause a reset
    // on every keystroke, defeating local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id])

  // Debounced autosave while typing in the *current* note. Gated on the
  // lastNoteIdRef so a switch in flight doesn't trigger a save against the
  // wrong id.
  useEffect(() => {
    if (!note) return
    if (lastNoteIdRef.current !== note.id) return
    const snap = snapshotRef.current
    if (title === snap.title && body === snap.body) return
    const handle = setTimeout(() => {
      persist(note.id, title, body)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [title, body, note?.id, persist])

  const flushNow = useCallback((): void => {
    if (!note) return
    if (lastNoteIdRef.current !== note.id) return
    const snap = snapshotRef.current
    if (title === snap.title && body === snap.body) return
    persist(note.id, title, body)
  }, [note?.id, title, body, persist])

  return { title, body, setTitle, setBody, flushNow }
}

/**
 * Materialize a set of notes as real `.md` {@link MessageAttachment}s via
 * the main-process ingest pipeline. Used by the composer when sending: the
 * caller passes the chosen `noteIds` along with the chat's destination
 * scope, and gets back a list of attachments ready to merge with whatever
 * file attachments the user picked.
 *
 * Rejects on the underlying IPC error shape so callers can `try/await` and
 * surface failures the same way they do for direct exceptions.
 */
export function useAttachNotesAsFiles() {
  return useMutation({
    mutationFn: async (
      input: NoteAttachAsFilesInputDto
    ): Promise<MessageAttachment[]> => {
      const result = await window.api.notes.attachAsFiles(input)
      if (!result.success) {
        throw new Error(result.error || 'Note attachment failed')
      }
      return result.files
    }
  })
}

export function useReorderNoteFolders() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (orderedIds: string[]) =>
      window.api.noteFolders.reorder(orderedIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['note-folders'] })
    }
  })
}
