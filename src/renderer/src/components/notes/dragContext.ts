import { createContext, useContext } from 'react'

export type NotesDrag =
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string }
  | null

export interface NotesDragContextValue {
  drag: NotesDrag
  setDrag: (drag: NotesDrag) => void
}

export const NotesDragContext = createContext<NotesDragContextValue>({
  drag: null,
  setDrag: () => {}
})

export function useNotesDrag(): NotesDragContextValue {
  return useContext(NotesDragContext)
}
