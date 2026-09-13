import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Copy, NotebookPen } from 'lucide-react'
import { useSaveMessageNote } from '../../hooks/useNotes'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'

interface MenuState {
  id: number
  x: number
  y: number
  text: string
}

/** Capture before focusing the menu changes the browser selection. */
export function messageContextText(root: HTMLElement, target: Element, selection: Selection | null): string {
  const message = target.closest<HTMLElement>('[data-message-markdown]')
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    if (root.contains(range.startContainer) && root.contains(range.endContainer) && range.intersectsNode(target)) {
      const selected = selection.toString()
      if (selected.trim()) {
        // Selecting the complete rendered message can retain its exact source.
        if (message && selected.trim() === message.textContent?.trim()) {
          return message.dataset.messageMarkdown ?? selected
        }
        return selected
      }
    }
  }
  return message && root.contains(message) ? message.dataset.messageMarkdown ?? '' : ''
}

export function useMessageContextMenu(chatId: string) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const nextId = useRef(0)
  const profileId = useAuthStore((s) => s.currentUser?.id)
  const close = useCallback(() => setMenu(null), [])
  const closeCurrent = useCallback(() => setMenu((current) => current === menu ? null : current), [menu])
  useEffect(close, [chatId, profileId, close])
  const onContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || event.target.closest('input, textarea, [contenteditable="true"]')) {
      setMenu(null)
      return
    }
    const text = messageContextText(event.currentTarget, event.target, window.getSelection())
    if (!text.trim()) {
      setMenu(null)
      return
    }
    event.preventDefault()
    const rect = event.target.getBoundingClientRect()
    setMenu({ id: ++nextId.current, text, x: event.clientX || rect.left, y: event.clientY || rect.bottom })
  }, [])
  return {
    onContextMenu,
    menu: menu ? <MessageContextMenu key={menu.id} {...menu} onClose={closeCurrent} /> : null
  }
}

function MessageContextMenu({ x, y, text, onClose }: MenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const mounted = useRef(true)
  const saveMessageNote = useSaveMessageNote()

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    })
    if (error) menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
  }, [x, y, error])

  useLayoutEffect(() => {
    mounted.current = true
    const menu = ref.current
    const previousFocus = document.activeElement as HTMLElement | null
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const outside = (event: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    // Streaming follows the transcript with programmatic scroll events. Only
    // user scrolling dismisses the captured excerpt's actions.
    window.addEventListener('wheel', onClose, true)
    window.addEventListener('touchmove', onClose, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      mounted.current = false
      const hadFocus = menu?.contains(document.activeElement)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('wheel', onClose, true)
      window.removeEventListener('touchmove', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      if (hadFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [onClose])

  const copy = async (): Promise<void> => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      await navigator.clipboard.writeText(text)
      onClose()
    } catch (err) {
      setError(unwrapIpcError(err, 'Could not copy text.'))
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const note = await saveMessageNote(text)
      // Saving may finish after the user dismisses the menu or changes chats.
      if (note && mounted.current) {
        const ui = useUIStore.getState()
        ui.setActiveNoteId(note.id)
        ui.setActiveView('note-detail')
        onClose()
      }
    } catch (err) {
      setError(unwrapIpcError(err, 'Could not save to Notes.'))
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (['Escape', 'Tab', 'PageUp', 'PageDown'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
      if (!items.length) return
      const current = items.findIndex((item) => item === document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
  }

  // Mouse and keyboard share focus, so the initial Copy highlight cannot stay
  // behind when the pointer moves onto Save to Notes.
  const focusItem = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!event.currentTarget.disabled) event.currentTarget.focus({ preventScroll: true })
  }
  const itemClass = 'flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-[var(--color-text)] focus:bg-[var(--color-bg-hover)] focus:outline-none transition-colors duration-100 motion-reduce:transition-none disabled:opacity-50'
  return createPortal(
    <div ref={ref} role="menu" aria-label="Message actions" onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{ position: 'fixed', ...position }}
      className="app-popover-surface z-[100] w-48 rounded-lg border border-[var(--color-border)] p-1 shadow-lg">
      <button type="button" role="menuitem" disabled={busy} className={itemClass} onPointerEnter={focusItem} onPointerMove={focusItem} onClick={() => void copy()}><Copy size={14} />Copy text</button>
      <button type="button" role="menuitem" disabled={busy} className={itemClass} onPointerEnter={focusItem} onPointerMove={focusItem} onClick={() => void save()}><NotebookPen size={14} />Save to Notes</button>
      {error && <p role="alert" className="break-words px-3 py-2 text-xs text-[var(--color-danger)]">{error}</p>}
    </div>, document.body
  )
}
