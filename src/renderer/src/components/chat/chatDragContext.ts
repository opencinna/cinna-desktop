import { createContext, useContext } from 'react'

/**
 * State the Chats list's rows share. The chat row being dragged in the Chats list, and the innermost group it was
 * picked up in: the flat list, one "who" group, one day group or Pinned. A row
 * accepts a drop only from its own group, so a drag never moves a chat into
 * another day or to another agent. Set on `dragstart`, cleared on `dragend`.
 */
export type ChatsDrag = { id: string; group: string } | null

export interface ChatsDragContextValue {
  drag: ChatsDrag
  setDrag: (drag: ChatsDrag) => void
  /** A row's right-click menu is open: no row opens its tooltip over it. */
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  /** A row's title is being edited in place: the Active block holds, so the row does not remount under the input. */
  renaming: boolean
  setRenaming: (renaming: boolean) => void
}

export const ChatsDragContext = createContext<ChatsDragContextValue>({
  drag: null,
  setDrag: () => {},
  menuOpen: false,
  setMenuOpen: () => {},
  renaming: false,
  setRenaming: () => {}
})

export function useChatsDrag(): ChatsDragContextValue {
  return useContext(ChatsDragContext)
}
