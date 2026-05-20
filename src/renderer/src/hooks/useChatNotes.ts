import { useCallback, useEffect, useState } from 'react'

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
 * Composer-local buffer of notes the user attached via the `?` mention
 * popup. Mirrors {@link useChatAttachments} in shape — keyed by `chatId`
 * so switching chats wipes the buffer — but intentionally minimal: notes
 * aren't materialized into files until send time, so there's no upload
 * state machine to manage here.
 */
export function useChatNotes(chatId: string | null): ChatNotesAPI {
  const [notes, setNotes] = useState<NoteRef[]>([])

  useEffect(() => {
    setNotes([])
  }, [chatId])

  const add = useCallback((note: NoteRef) => {
    setNotes((curr) =>
      curr.some((n) => n.id === note.id) ? curr : [...curr, note]
    )
  }, [])

  const remove = useCallback((id: string) => {
    setNotes((curr) => curr.filter((n) => n.id !== id))
  }, [])

  const clear = useCallback(() => setNotes([]), [])

  return { notes, add, remove, clear }
}
