import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { useUIStore } from '../stores/ui.store'

/** How long the pointer rests at the window's left edge before the sidebar peeks. */
export const PEEK_OPEN_DELAY_MS = 120
/** How long after the pointer leaves the sidebar before it hides. */
export const PEEK_CLOSE_DELAY_MS = 300
/**
 * How often a peeking sidebar looks again at what holds it: a close held back
 * by an open menu, dialog or field, and whether the pointer is still on it
 * when something under the pointer went away without a mouse event.
 */
export const PEEK_BLOCK_POLL_MS = 150
/**
 * How long a peek that started with the pointer elsewhere (a reveal from code,
 * such as Show in the Chats list) stays up before it hides, so the user sees
 * what it was opened to show.
 */
export const PEEK_REVEAL_HOLD_MS = 2500

/**
 * Something that must keep a peeking sidebar on screen even with the pointer
 * away from it.
 *
 * Menus, popovers and dialogs opened from the sidebar are portaled to
 * `document.body`, outside the sidebar's DOM, so they are found at document
 * level: anything marked as a menu, listbox or dialog, and any frosted popover
 * portaled straight into `body` (the footer's Interface popover has no role).
 * This cannot tell a menu opened from the sidebar from one opened elsewhere;
 * either holds the sidebar open, and the close follows once it is gone.
 * A field being edited inside the sidebar — a chat rename, a search — holds
 * it too, so the text does not vanish under the user's typing.
 */
export function sidebarCloseBlocked(sidebar: HTMLElement | null, doc: Document = document): boolean {
  if (
    doc.querySelector(
      '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], body > .app-popover-surface'
    )
  ) {
    return true
  }
  const active = doc.activeElement
  if (!sidebar || !(active instanceof HTMLElement) || !sidebar.contains(active)) return false
  return active.isContentEditable || active.matches('input, textarea, select')
}

export interface HoverDockTimers {
  /** Pointer arrived at the edge strip. */
  enterZone: () => void
  leaveZone: () => void
  /** The pointer moved, on the sidebar or off it. */
  pointerMoved: (inside: boolean) => void
  /** The peek started: with the pointer elsewhere it was revealed from code, and holds a while before closing. */
  start: () => void
  /** Something may have changed under a still pointer: close if it is not on the sidebar. */
  check: () => void
  /** Close now (the window lost focus), still subject to the blockers. */
  closeNow: () => void
  /** Drop every pending timer, e.g. when the peek ends or the mode changes. */
  reset: () => void
}

/**
 * The timer rules of hover docking, apart from React so they can be driven
 * with fake timers: a dwell at the edge opens, leaving the edge first cancels;
 * the pointer off the sidebar closes it after a delay that coming back
 * cancels, and a blocked close waits for the block to clear, then takes the
 * full delay if the pointer is still away.
 */
export function createHoverDockTimers({
  setPeek,
  isBlocked,
  pointerInside
}: {
  setPeek: (peek: boolean) => void
  isBlocked: () => boolean
  /** Where the pointer really is now; asked again before every close. */
  pointerInside: () => boolean
}): HoverDockTimers {
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined

  const clearOpen = (): void => {
    clearTimeout(openTimer)
    openTimer = undefined
  }
  const clearClose = (): void => {
    clearTimeout(closeTimer)
    closeTimer = undefined
  }
  const scheduleClose = (delay = PEEK_CLOSE_DELAY_MS): void => {
    clearClose()
    closeTimer = setTimeout(tryClose, delay)
  }
  const waitForUnblock = (): void => {
    closeTimer = setTimeout(() => {
      closeTimer = undefined
      if (pointerInside()) return
      if (isBlocked()) waitForUnblock()
      else scheduleClose()
    }, PEEK_BLOCK_POLL_MS)
  }
  function tryClose(): void {
    closeTimer = undefined
    if (pointerInside()) return
    if (isBlocked()) waitForUnblock()
    else setPeek(false)
  }

  return {
    enterZone: () => {
      clearOpen()
      openTimer = setTimeout(() => {
        openTimer = undefined
        setPeek(true)
      }, PEEK_OPEN_DELAY_MS)
    },
    leaveZone: clearOpen,
    pointerMoved: (inside) => {
      if (inside) clearClose()
      else if (closeTimer === undefined) scheduleClose()
    },
    start: () => {
      if (!pointerInside()) scheduleClose(PEEK_REVEAL_HOLD_MS)
    },
    check: () => {
      if (closeTimer === undefined && !pointerInside()) scheduleClose()
    },
    closeNow: () => {
      clearClose()
      tryClose()
    },
    reset: () => {
      clearOpen()
      clearClose()
    }
  }
}

export interface SidebarHoverDockHandlers {
  hotZone: { onMouseEnter: () => void; onMouseLeave: () => void }
  sidebar: { onMouseMove: (event: ReactMouseEvent) => void }
}

/** The element a portal put straight into `body` that holds `node`. */
function bodyChild(node: Element): Element | null {
  let at: Element | null = node
  while (at && at.parentElement !== at.ownerDocument.body) at = at.parentElement
  return at
}

/**
 * Wires `createHoverDockTimers` to the UI store for the sidebar in hover
 * docking. `sidebarRef` is the sidebar's wrapper.
 *
 * Where the pointer is comes from every `mousemove` in the document, not from
 * enter/leave on the sidebar: a peek that starts under a pointer elsewhere
 * (`revealSidebar`) or a portaled dialog that unmounts under a still pointer
 * produces no leave at all. A move counts as "on the sidebar" when it passed
 * through the sidebar's React handler — React bubbles along the component
 * tree, so a popover portaled from inside the sidebar (and the edge strip) is
 * on it while the pointer is there. Before a close, the pointer is looked up
 * again: the element under it has to still be the sidebar or that popover.
 */
export function useSidebarHoverDock(sidebarRef: RefObject<HTMLElement | null>): SidebarHoverDockHandlers {
  const docking = useUIStore((s) => s.sidebarDocking)
  const peek = useUIStore((s) => s.sidebarPeek)
  const hover = docking === 'hover'
  const hoverRef = useRef(hover)
  /** The last move the sidebar's React handler saw, to recognise it at document level. */
  const lastInsideMove = useRef<{ event: Event; target: Element } | null>(null)
  const pointer = useRef<{ inside: boolean; target: Element | null; x: number | null; y: number | null }>({
    inside: false,
    target: null,
    x: null,
    y: null
  })

  const timers = useMemo(() => {
    const pointerInside = (): boolean => {
      const state = pointer.current
      const sidebar = sidebarRef.current
      if (!sidebar) return false
      const target = state.target
      const doc = sidebar.ownerDocument
      if (state.x !== null && state.y !== null && typeof doc.elementFromPoint === 'function') {
        const hit = doc.elementFromPoint(state.x, state.y)
        if (!hit) return false
        // Asked before `inside`: a reveal can slide the sidebar in under a
        // pointer that has not moved since it was over the chat.
        if (sidebar.contains(hit)) return true
        if (!state.inside || !target || !target.isConnected || sidebar.contains(target)) return false
        return bodyChild(target)?.contains(hit) ?? false
      }
      return !!target && target.isConnected
    }
    return createHoverDockTimers({
      setPeek: (next) => {
        const state = useUIStore.getState()
        if (state.sidebarDocking === 'hover' && state.sidebarPeek !== next) state.setSidebarPeek(next)
      },
      isBlocked: () => sidebarCloseBlocked(sidebarRef.current),
      pointerInside
    })
  }, [sidebarRef])

  useEffect(() => {
    hoverRef.current = hover
  }, [hover])

  // The pointer, followed for as long as the mode is on: a reveal has to know
  // it starts with the pointer elsewhere.
  useEffect(() => {
    if (!hover) return
    const moved = (event: MouseEvent): void => {
      const inside = lastInsideMove.current?.event === event
      pointer.current = {
        inside,
        target: inside ? lastInsideMove.current!.target : null,
        x: event.clientX,
        y: event.clientY
      }
      if (useUIStore.getState().sidebarPeek) timers.pointerMoved(inside)
    }
    const leftDocument = (event: MouseEvent): void => {
      if (event.relatedTarget) return
      pointer.current = { inside: false, target: null, x: null, y: null }
      if (useUIStore.getState().sidebarPeek) timers.pointerMoved(false)
    }
    const blurred = (): void => {
      pointer.current = { inside: false, target: null, x: null, y: null }
      if (useUIStore.getState().sidebarPeek) timers.closeNow()
    }
    document.addEventListener('mousemove', moved)
    document.addEventListener('mouseout', leftDocument)
    window.addEventListener('blur', blurred)
    return () => {
      document.removeEventListener('mousemove', moved)
      document.removeEventListener('mouseout', leftDocument)
      window.removeEventListener('blur', blurred)
    }
  }, [hover, timers])

  // While it peeks: close if the pointer is not on it, now and whenever
  // something under a still pointer may have gone.
  useEffect(() => {
    if (!hover || !peek) {
      timers.reset()
      return
    }
    timers.start()
    const poll = setInterval(timers.check, PEEK_BLOCK_POLL_MS)
    return () => clearInterval(poll)
  }, [hover, peek, timers])
  useEffect(() => () => timers.reset(), [timers])

  return useMemo(
    () => ({
      hotZone: {
        onMouseEnter: () => {
          if (hoverRef.current && !useUIStore.getState().sidebarPeek) timers.enterZone()
        },
        onMouseLeave: timers.leaveZone
      },
      sidebar: {
        onMouseMove: (event: ReactMouseEvent) => {
          lastInsideMove.current = { event: event.nativeEvent, target: event.target as Element }
        }
      }
    }),
    [timers]
  )
}
