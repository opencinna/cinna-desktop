import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
import { unwrapIpcError } from '../../utils/ipcError'

/** One item of a right-click menu: the shared menu row, with a keyboard focus mark. */
export const CONTEXT_MENU_ITEM = `${MENU_ITEM} focus-visible:bg-[var(--color-bg-hover)] focus-visible:outline-none`
/** The menu surface, narrower than `OpenInMenu`'s. */
export const CONTEXT_MENU_SURFACE = MENU_SURFACE.replace('w-56', 'w-44')

interface ContextMenuProps {
  /** The pointer, where the menu opens; clamped to the viewport. */
  x: number
  y: number
  /** What the menu was opened on: a scroll of anything containing it closes the menu. */
  anchor: HTMLElement | null
  /** The menu's accessible name. */
  label: string
  /** A failed pick's reason, shown last in the menu. */
  error?: string | null
  className?: string
  onClose: () => void
  children: ReactNode
}

/**
 * The shell of a right-click menu. Portaled, opened at the pointer and kept
 * inside the window; the first enabled item takes focus and the arrow keys
 * move between items. Closes on Escape, Tab, an outside click, a scroll that
 * moves the anchor, a resize and the window losing focus. Closing on a pick is
 * the caller's: see {@link useContextMenuAction}.
 */
export function ContextMenu({
  x, y, anchor, label, error, className = CONTEXT_MENU_SURFACE, onClose, children
}: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number }>({ left: x, top: y })
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const clamp = (): void => {
      const rect = menu.getBoundingClientRect()
      const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
      // Pushed up to fit, the bottom edge stays put and anything arriving later
      // (an error line, a late item) grows the menu upward. Re-decided on every
      // size change: content shrinking back to fit below the pointer (a retried
      // pick clearing its error) returns the menu to where it opened.
      const pushedUp = y + rect.height > window.innerHeight - 8
      // Taller than the window: pin the top, as nothing else can show it whole.
      if (pushedUp && rect.height <= window.innerHeight - 16) setPosition({ left, bottom: 8 })
      else setPosition({ left, top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) })
    }
    clamp()
    // An item whose condition resolves after opening grows the menu; keep it inside the window.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(clamp)
    observer.observe(menu)
    return () => observer.disconnect()
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
    // Only a scroller holding the anchor moves it; the transcript scrolls on
    // its own while a turn streams and must not close the menu.
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

  const errorLine = <p role="alert" className="break-words px-2 py-1.5 text-xs text-[var(--color-danger)]">{error}</p>

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{ position: 'fixed', ...position }}
      className={className}
    >
      {/* Pinned to the bottom, the menu grows upward: the error goes above the
          items so the one just clicked stays under the pointer. */}
      {error && position.bottom !== undefined && errorLine}
      {children}
      {error && position.bottom === undefined && errorLine}
    </div>,
    document.body
  )
}

/**
 * A menu pick that can fail: one at a time, the menu closes when it succeeds
 * and stays open with the reason when it does not (ux_rules §6).
 */
export function useContextMenuAction(onClose: () => void): {
  busy: boolean
  error: string | null
  run: (action: () => Promise<unknown>, fallback: string) => Promise<void>
} {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const run = useCallback(async (action: () => Promise<unknown>, fallback: string): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      busyRef.current = false
      onClose()
    } catch (err) {
      busyRef.current = false
      setError(unwrapIpcError(err, fallback))
      setBusy(false)
    }
  }, [onClose])
  return { busy, error, run }
}
