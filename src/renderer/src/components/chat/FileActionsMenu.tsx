import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, ExternalLink, FolderOpen, Globe, Loader2, MoreHorizontal, Upload } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { MODAL_HEADER_ICON } from '../ui/modalHeader'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'

/**
 * Marks a surface the file preview owns although it is portaled outside the
 * card, so the preview's outside-press close leaves a press on it alone.
 */
export const PREVIEW_POPOVER_ATTR = 'data-file-preview-popover'

interface FileActionsMenuProps {
  /** The action in flight, if any: the trigger spins and both items wait. */
  pendingAction: 'open' | 'reveal' | 'browser' | null
  /** The body already says the file has gone: its actions could only fail. */
  fileGone: boolean
  onOpen: () => void
  onReveal: () => void
  /** Offered for an HTML file: Open in browser, between Open and Open folder. */
  onOpenInBrowser?: () => void
  /** Copy content, after Open folder. Copies what the preview read, so it stays clickable while an action runs. */
  onCopy: () => void
  /** There is no text to copy: still loading, or the body is a notice or an error. */
  copyDisabled: boolean
  /** Just copied: the trigger says so for a moment, since the menu has closed by then. */
  copied: boolean
  /** Offered when the file can be published: Publish, after a separator below Copy content. */
  onPublish?: () => void
  /** The preview is fading out: an open menu goes with it. */
  dismissed: boolean
}

/**
 * The file preview's ⋯ menu: Open, Open in browser (HTML only), Open folder and
 * Copy content for a file an agent named, then Publish under a separator when
 * the file can be published (it was a header button; it is as occasional as these).
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
  onOpenInBrowser,
  onCopy,
  copyDisabled,
  copied,
  onPublish,
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

  // A press inside the HTML preview's frame reaches the frame, not this
  // document: no outside press closes the menu. Focus moving into the frame
  // blurs the window with the frame as the active element — close on that.
  // (Escape inside the frame never reaches the app; that one stays open.)
  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onBlur = (): void => {
      // A tick later: the frame is the active element by then whichever order Chromium reports them in.
      timer = setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement) setOpen(false)
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      clearTimeout(timer)
    }
  }, [open, setOpen])

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
        className={MODAL_HEADER_ICON + ` text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]
          hover:text-[var(--color-text)]`}
      >
        {pendingAction !== null ? (
          <Loader2 size={14} className="animate-spin" />
        ) : copied ? (
          <Check size={14} className="text-[var(--color-success)]" />
        ) : (
          <MoreHorizontal size={14} />
        )}
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
            {onOpenInBrowser && (
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                disabled={disabled}
                onClick={() => run(onOpenInBrowser)}
              >
                <Globe size={12} />
                Open in browser
              </button>
            )}
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
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              disabled={copyDisabled}
              onClick={() => run(onCopy)}
            >
              <Copy size={12} />
              Copy content
            </button>
            {onPublish && (
              <>
                <div role="separator" className="my-1 border-t border-[var(--color-border)]" />
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  disabled={fileGone}
                  onClick={() => run(onPublish)}
                >
                  <Upload size={12} />
                  Publish
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
