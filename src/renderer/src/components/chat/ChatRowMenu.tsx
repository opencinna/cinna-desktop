import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
import { unwrapIpcError } from '../../utils/ipcError'

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

const SURFACE = MENU_SURFACE.replace('w-56', 'w-44')
const ITEM = `${MENU_ITEM} focus-visible:bg-[var(--color-bg-hover)] focus-visible:outline-none`

/**
 * A chat row's right-click menu. Portaled, opened at the pointer and kept
 * inside the window. Closes on Escape, an outside click, a scroll that moves
 * the row, a resize, the window losing focus, and a pick that succeeds; a pick
 * that fails stays open and says why.
 */
export function ChatRowMenu({
  x, y, anchor, pinned, canOpenFolder, deleteDisabled, onPin, onRename, onOpenFolder, onDelete, onClose
}: ChatRowMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    })
  }, [x, y, error])

  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    // Only a scroller holding the row moves it; the transcript scrolls on its
    // own while a turn streams and must not close the menu.
    const scroll = (event: Event): void => {
      if (event.target instanceof Node && anchor && !event.target.contains(anchor)) return
      onClose()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, anchor])

  const run = async (action: () => Promise<unknown>, fallback: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      onClose()
    } catch (err) {
      setError(unwrapIpcError(err, fallback))
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus()
  }

  const PinIcon = pinned ? PinOff : Pin
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Chat actions"
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{ position: 'fixed', ...position }}
      className={SURFACE}
    >
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
      {error && <p role="alert" className="break-words px-2 py-1.5 text-xs text-[var(--color-danger)]">{error}</p>}
    </div>,
    document.body
  )
}
