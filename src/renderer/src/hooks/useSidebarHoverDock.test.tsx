import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { useUIStore } = await import('../stores/ui.store')
const { useSidebarHoverDock, PEEK_OPEN_DELAY_MS, PEEK_CLOSE_DELAY_MS, PEEK_BLOCK_POLL_MS, PEEK_REVEAL_HOLD_MS } = await import('./useSidebarHoverDock')

/**
 * A sidebar with the hook's handlers and a field inside it, the edge band, a
 * main area beside it, and optionally a dialog portaled from inside it.
 */
function Harness({ dialog = false }: { dialog?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const dock = useSidebarHoverDock(ref)
  return (
    <>
      <div ref={ref} data-testid="sidebar" {...dock.sidebar}>
        <input data-testid="rename" />
        {dialog && createPortal(<div role="dialog" data-testid="dialog" />, document.body)}
      </div>
      <div data-testid="zone" {...dock.hotZone} />
      <div data-testid="main">
        <div data-sidebar-band-limit data-testid="column" />
      </div>
    </>
  )
}

/** The edge band's rect: jsdom lays nothing out, so the zone's is stubbed. */
const BAND = { left: 0, top: 44, right: 142, bottom: 800 }
const IN_BAND = { clientX: 40, clientY: 400 }
/** Where the chat column starts; a narrow window pulls it into the band. */
let columnLeft = 400

const peek = (): boolean => useUIStore.getState().sidebarPeek
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}
const move = (testId: string): void => {
  act(() => {
    fireEvent.mouseMove(screen.getByTestId(testId))
  })
}

/**
 * A move at a point in the chat. The band takes no pointer events, so what is
 * under the pointer there is the chat.
 */
const moveAt = (point: { clientX: number; clientY: number; buttons?: number }): void => {
  act(() => {
    fireEvent.mouseMove(screen.getByTestId('main'), point)
  })
}

/** Open by a dwell in the edge band, then take the pointer from the sidebar to the chat. */
function openThenLeave(): void {
  moveAt(IN_BAND)
  advance(PEEK_OPEN_DELAY_MS)
  expect(peek()).toBe(true)
  move('sidebar')
  move('main')
}

let added: HTMLElement[] = []
function addToBody(el: HTMLElement): HTMLElement {
  document.body.appendChild(el)
  added.push(el)
  return el
}

beforeEach(() => {
  vi.useFakeTimers()
  columnLeft = 400
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r =
      this.dataset.testid === 'zone'
        ? BAND
        : this.dataset.testid === 'column'
          ? { left: columnLeft, top: 0, right: columnLeft + 768, bottom: 800 }
          : { left: 0, top: 0, right: 0, bottom: 0 }
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r } as DOMRect
  })
  useUIStore.setState({ sidebarDocking: 'hover', sidebarPeek: false, sidebarOpen: true })
})

afterEach(() => {
  for (const el of added) el.remove()
  added = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useSidebarHoverDock', () => {
  it('peeks after the pointer stays in the edge band, and not before', () => {
    render(<Harness />)
    moveAt(IN_BAND)
    advance(PEEK_OPEN_DELAY_MS - 1)
    expect(peek()).toBe(false)
    advance(1)
    expect(peek()).toBe(true)
  })

  it('peeks from anywhere across the band, moving within it without restarting the dwell', () => {
    render(<Harness />)
    moveAt({ clientX: BAND.right - 1, clientY: 300 })
    advance(PEEK_OPEN_DELAY_MS / 2)
    moveAt({ clientX: 5, clientY: 600 })
    advance(PEEK_OPEN_DELAY_MS / 2)
    expect(peek()).toBe(true)
  })

  it('does not peek when the pointer leaves the band before the dwell', () => {
    render(<Harness />)
    moveAt(IN_BAND)
    advance(PEEK_OPEN_DELAY_MS - 20)
    moveAt({ clientX: BAND.right, clientY: 400 })
    advance(PEEK_OPEN_DELAY_MS * 5)
    expect(peek()).toBe(false)
  })

  it('stops the band where a content column starts, in a narrow window', () => {
    columnLeft = 30
    render(<Harness />)
    moveAt(IN_BAND)
    advance(PEEK_OPEN_DELAY_MS * 5)
    expect(peek()).toBe(false)
    moveAt({ clientX: 20, clientY: 400 })
    advance(PEEK_OPEN_DELAY_MS)
    expect(peek()).toBe(true)
  })

  it('does not peek from above the band, where the top bar is', () => {
    render(<Harness />)
    moveAt({ clientX: 40, clientY: BAND.top - 1 })
    advance(PEEK_OPEN_DELAY_MS * 5)
    expect(peek()).toBe(false)
  })

  it('does not peek while a button is held, as in a text selection', () => {
    render(<Harness />)
    moveAt({ ...IN_BAND, buttons: 1 })
    advance(PEEK_OPEN_DELAY_MS * 5)
    expect(peek()).toBe(false)
  })

  it('does not peek while a menu or dialog is open over the chat', () => {
    render(<Harness />)
    const dialog = addToBody(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    moveAt(IN_BAND)
    advance(PEEK_OPEN_DELAY_MS * 5)
    expect(peek()).toBe(false)
    dialog.remove()
    moveAt({ clientX: 50, clientY: 420 })
    advance(PEEK_OPEN_DELAY_MS)
    expect(peek()).toBe(true)
  })

  it('does not peek when the pointer reaches the band during a reveal from code', () => {
    render(<Harness />)
    moveAt(IN_BAND)
    act(() => useUIStore.getState().revealSidebar())
    advance(PEEK_OPEN_DELAY_MS)
    move('main')
    // The later reveal still takes its hold.
    advance(PEEK_REVEAL_HOLD_MS)
    expect(peek()).toBe(false)
    act(() => useUIStore.getState().revealSidebar())
    advance(PEEK_REVEAL_HOLD_MS - 1)
    expect(peek()).toBe(true)
  })

  it('does nothing in fixed docking', () => {
    useUIStore.setState({ sidebarDocking: 'fixed' })
    render(<Harness />)
    moveAt(IN_BAND)
    advance(PEEK_OPEN_DELAY_MS * 5)
    expect(peek()).toBe(false)
  })

  it('stays while the pointer rests on the sidebar', () => {
    render(<Harness />)
    openThenLeave()
    move('sidebar')
    advance(PEEK_CLOSE_DELAY_MS * 10)
    expect(peek()).toBe(true)
  })

  it('hides a delay after the pointer leaves the sidebar', () => {
    render(<Harness />)
    openThenLeave()
    advance(PEEK_CLOSE_DELAY_MS - 1)
    expect(peek()).toBe(true)
    advance(1)
    expect(peek()).toBe(false)
  })

  it('stays when the pointer comes back before the delay', () => {
    render(<Harness />)
    openThenLeave()
    advance(PEEK_CLOSE_DELAY_MS - 50)
    move('sidebar')
    advance(PEEK_CLOSE_DELAY_MS * 5)
    expect(peek()).toBe(true)
  })

  it('holds a reveal made while the pointer is elsewhere, then hides it', () => {
    render(<Harness />)
    move('main')
    act(() => useUIStore.getState().revealSidebar())
    expect(peek()).toBe(true)
    // Moving about the chat does not cut the hold short.
    move('main')
    advance(PEEK_REVEAL_HOLD_MS - 1)
    expect(peek()).toBe(true)
    advance(1)
    expect(peek()).toBe(false)
  })

  it('keeps a reveal that slid in under a still pointer', () => {
    render(<Harness />)
    move('main')
    // The pointer has not moved, but the sidebar now lies under it.
    const sidebar = screen.getByTestId('sidebar')
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null }
    const original = doc.elementFromPoint
    doc.elementFromPoint = () => sidebar
    try {
      act(() => useUIStore.getState().revealSidebar())
      advance(PEEK_REVEAL_HOLD_MS * 2)
      expect(peek()).toBe(true)
    } finally {
      if (original) doc.elementFromPoint = original
      else delete doc.elementFromPoint
    }
  })

  it('keeps a reveal the pointer goes onto, and hides it a delay after it leaves', () => {
    render(<Harness />)
    move('main')
    act(() => useUIStore.getState().revealSidebar())
    move('sidebar')
    advance(PEEK_REVEAL_HOLD_MS * 2)
    expect(peek()).toBe(true)
    move('main')
    advance(PEEK_CLOSE_DELAY_MS)
    expect(peek()).toBe(false)
  })

  it('hides once a dialog from the sidebar closes under a still pointer', () => {
    const { rerender } = render(<Harness dialog />)
    act(() => useUIStore.getState().setSidebarPeek(true))
    // On the portaled dialog: on the sidebar, as far as the pointer goes.
    move('dialog')
    advance(PEEK_CLOSE_DELAY_MS * 4)
    expect(peek()).toBe(true)
    // It goes away with no mouse event; the pointer is now over the chat.
    rerender(<Harness />)
    advance(PEEK_BLOCK_POLL_MS + PEEK_CLOSE_DELAY_MS)
    expect(peek()).toBe(false)
  })

  it('hides when the window loses focus', () => {
    render(<Harness />)
    act(() => useUIStore.getState().setSidebarPeek(true))
    move('sidebar')
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(peek()).toBe(false)
  })

  it('hides after the pointer leaves the window from the edge', () => {
    render(<Harness />)
    moveAt(IN_BAND)
    advance(PEEK_OPEN_DELAY_MS)
    expect(peek()).toBe(true)
    act(() => {
      fireEvent.mouseOut(screen.getByTestId('sidebar'), { relatedTarget: null })
    })
    advance(PEEK_CLOSE_DELAY_MS)
    expect(peek()).toBe(false)
  })

  it('stays while a menu is open, and hides once it has closed', () => {
    render(<Harness />)
    openThenLeave()
    const menu = addToBody(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    advance(PEEK_CLOSE_DELAY_MS * 10)
    expect(peek()).toBe(true)
    menu.remove()
    advance(PEEK_BLOCK_POLL_MS)
    // The close starts when the block clears, and takes the full delay.
    advance(PEEK_CLOSE_DELAY_MS - 1)
    expect(peek()).toBe(true)
    advance(1)
    expect(peek()).toBe(false)
  })

  it('stays while a portaled popover with no role is open, but not for a toast', () => {
    render(<Harness />)
    openThenLeave()
    const popover = addToBody(document.createElement('div'))
    popover.className = 'app-popover-surface'
    // Not portaled into body: a toast in the shell must not hold the sidebar.
    const toast = document.createElement('div')
    toast.className = 'app-popover-surface'
    screen.getByTestId('main').appendChild(toast)
    advance(PEEK_CLOSE_DELAY_MS * 4)
    expect(peek()).toBe(true)
    popover.remove()
    advance(PEEK_BLOCK_POLL_MS + PEEK_CLOSE_DELAY_MS)
    expect(peek()).toBe(false)
  })

  it('stays while a dialog is open', () => {
    render(<Harness />)
    openThenLeave()
    const dialog = addToBody(document.createElement('div'))
    dialog.setAttribute('aria-modal', 'true')
    advance(PEEK_CLOSE_DELAY_MS * 4)
    expect(peek()).toBe(true)
    dialog.remove()
    advance(PEEK_BLOCK_POLL_MS + PEEK_CLOSE_DELAY_MS)
    expect(peek()).toBe(false)
  })

  it('stays while a field inside the sidebar has focus, but not one outside it', () => {
    render(<Harness />)
    openThenLeave()
    act(() => screen.getByTestId('rename').focus())
    advance(PEEK_CLOSE_DELAY_MS * 4)
    expect(peek()).toBe(true)

    const composer = addToBody(document.createElement('textarea'))
    act(() => composer.focus())
    advance(PEEK_BLOCK_POLL_MS + PEEK_CLOSE_DELAY_MS)
    expect(peek()).toBe(false)
  })

  it('does not close when the pointer comes back while the close was held', () => {
    render(<Harness />)
    openThenLeave()
    const menu = addToBody(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    advance(PEEK_CLOSE_DELAY_MS * 2)
    move('sidebar')
    menu.remove()
    advance(PEEK_CLOSE_DELAY_MS * 10)
    expect(peek()).toBe(true)
  })
})
