import { FolderOpen, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { CONTEXT_MENU_ITEM as ITEM, ContextMenu, useContextMenuAction } from '../ui/ContextMenu'

interface ChatRowMenuProps {
  /** The pointer, where the menu opens; clamped to the viewport. */
  x: number
  y: number
  /** The row: a scroll of anything containing it closes the menu. */
  anchor: HTMLElement | null
  pinned: boolean
  /** Only a chat whose primary agent is a folder agent has a folder to open. */
  canOpenFolder: boolean
  /** A running chat is not deleted, as its trash button says. */
  deleteDisabled: boolean
  onPin: () => Promise<unknown>
  onRename: () => void
  onOpenFolder: () => Promise<unknown>
  onDelete: () => void
  onClose: () => void
}

/**
 * A chat row's right-click menu, on the shared {@link ContextMenu} shell:
 * opened at the pointer, kept inside the window, closed on Escape, an outside
 * click, a scroll that moves the row, a resize, the window losing focus and a
 * pick that succeeds; a pick that fails stays open and says why.
 */
export function ChatRowMenu({
  x, y, anchor, pinned, canOpenFolder, deleteDisabled, onPin, onRename, onOpenFolder, onDelete, onClose
}: ChatRowMenuProps): React.JSX.Element {
  const { busy, error, run } = useContextMenuAction(onClose)

  const PinIcon = pinned ? PinOff : Pin
  return (
    <ContextMenu x={x} y={y} anchor={anchor} label="Chat actions" error={error} onClose={onClose}>
      <button type="button" role="menuitem" className={ITEM} disabled={busy}
        onClick={() => void run(onPin, pinned ? 'Could not unpin the chat.' : 'Could not pin the chat.')}>
        <PinIcon size={12} aria-hidden="true" />{pinned ? 'Unpin' : 'Pin'}
      </button>
      <button type="button" role="menuitem" className={ITEM} disabled={busy}
        onClick={() => { onRename(); onClose() }}>
        <Pencil size={12} aria-hidden="true" />Rename
      </button>
      {canOpenFolder && (
        <button type="button" role="menuitem" className={ITEM} disabled={busy}
          onClick={() => void run(onOpenFolder, 'Could not open the agent folder.')}>
          <FolderOpen size={12} aria-hidden="true" />Open Folder
        </button>
      )}
      <div role="separator" className="my-1 border-t border-[var(--color-border)]" />
      <button type="button" role="menuitem"
        className={`${ITEM} text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
        disabled={busy || deleteDisabled}
        title={deleteDisabled ? 'Interrupt the session before deleting it' : undefined}
        onClick={() => { onDelete(); onClose() }}>
        <Trash2 size={12} aria-hidden="true" />Delete
      </button>
    </ContextMenu>
  )
}
