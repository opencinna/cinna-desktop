import { useCallback } from 'react'
import { useComposerDraftField, useComposerDraftKey } from './useComposerDraft'

export interface NoteRef {
  id: string
  title: string
}

export interface ChatNotesAPI {
  notes: NoteRef[]
  add: (note: NoteRef) => void
  remove: (id: string) => void
  clear: () => void
}

/**
 * Draft buffer of notes the user attached via the `?` mention popup.
 * Notes survive navigation, scoped to the originating composer; notes
 * aren't materialized into files until send time, so there's no upload
 * state machine to manage here.
 */
export function useChatNotes(chatId: string | null, draftKey?: string): ChatNotesAPI {
  const defaultKey = useComposerDraftKey(chatId)
  const [notes, setNotes] = useComposerDraftField(draftKey ?? defaultKey, 'notes')

  const add = useCallback((note: NoteRef) => {
    setNotes((curr) =>
      curr.some((n) => n.id === note.id) ? curr : [...curr, note]
    )
  }, [setNotes])

  const remove = useCallback((id: string) => {
    setNotes((curr) => curr.filter((n) => n.id !== id))
  }, [setNotes])

  const clear = useCallback(() => setNotes([]), [setNotes])

  return { notes, add, remove, clear }
}
