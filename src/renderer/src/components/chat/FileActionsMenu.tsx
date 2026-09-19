import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FolderOpen, Loader2, MoreHorizontal } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'

/**
 * Marks a surface the file preview owns although it is portaled outside the
 * card, so the preview's outside-press close leaves a press on it alone.
 */
export const PREVIEW_POPOVER_ATTR = 'data-file-preview-popover'

interface FileActionsMenuProps {
  /** The action in flight, if any: the trigger spins and both items wait. */
  pendingAction: 'open' | 'reveal' | null
  /** The body already says the file has gone: its actions could only fail. */
  fileGone: boolean
  onOpen: () => void
  onReveal: () => void
  /** The preview is fading out: an open menu goes with it. */
  dismissed: boolean
}

/**
 * The file preview's ⋯ menu: Open and Open folder for a file an agent named.
 *
 * They used to be labelled header buttons; the header now holds the Contents
 * toggle, and these two are occasional. The trigger stays enabled while the
 * items are disabled, so the user can still see what is unavailable, and
 * turns into a spinner while an action runs — the menu has closed by then, and
 * the spinner stays inline (UX rule 1). A failure lands in the preview's
 * action-error row under the header, as it did for the buttons.
 *
 * Portaled to the body like every menu (UX rule 8), so it is outside the card:
 * a press on it is marked with {@link PREVIEW_POPOVER_ATTR} for the preview's
 * outside-press close, and Escape while it is open is taken in the capture
 * phase and stopped, so it closes the menu and not the preview.
 */
export function FileActionsMenu({
  pendingAction,
  fileGone,
  onOpen,
  onReveal,
  dismissed
}: FileActionsMenuProps): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  const { open, setOpen, triggerRef, popoverRef } = menu
  const disabled = pendingAction !== null || fileGone

  useEffect(() => {
    if (dismissed) setOpen(false)
  }, [dismissed, setOpen])

  const items = (): HTMLButtonElement[] =>
    Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []).filter(
      (item) => !item.disabled
    )

  // Focus the first usable item once the menu is laid out, so the keyboard
  // can act on it; with none usable, focus stays on the trigger.
  useEffect(() => {
    if (open && menu.style) items()[0]?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menu.style !== null])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        // Before the preview's own window listener, which would close it.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
      const list = items()
      if (list.length === 0) return
      e.preventDefault()
      const at = list.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? list.length - 1
            : e.key === 'ArrowDown'
              ? (at + 1) % list.length
              : (at - 1 + list.length) % list.length
      list[next].focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setOpen, triggerRef])

  const run = (fn: () => void): void => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
    fn()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More file actions"
        title="More file actions"
        className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]
          hover:text-[var(--color-text)] transition-colors"
      >
        {pendingAction !== null ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={14} />}
      </button>
      {open &&
        menu.style &&
        createPortal(
          <div
            ref={popoverRef}
            role="menu"
            aria-label="File actions"
            style={menu.style}
            className={MENU_SURFACE}
            {...{ [PREVIEW_POPOVER_ATTR]: '' }}
          >
            <button type="button" role="menuitem" className={MENU_ITEM} disabled={disabled} onClick={() => run(onOpen)}>
              <ExternalLink size={12} />
              Open
            </button>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              disabled={disabled}
              onClick={() => run(onReveal)}
            >
              <FolderOpen size={12} />
              Open folder
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
