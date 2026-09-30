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
 * A sidebar with the hook's handlers, an edge strip and a field inside it, a
 * main area beside it, and optionally a dialog portaled from inside it.
 */
function Harness({ dialog = false }: { dialog?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const dock = useSidebarHoverDock(ref)
  return (
    <>
      <div ref={ref} data-testid="sidebar" {...dock.sidebar}>
        <div data-testid="zone" {...dock.hotZone} />
        <input data-testid="rename" />
        {dialog && createPortal(<div role="dialog" data-testid="dialog" />, document.body)}
      </div>
      <div data-testid="main" />
    </>
  )
}

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

/** Open by a dwell at the edge, then take the pointer from the sidebar to the chat. */
function openThenLeave(): void {
  act(() => {
    fireEvent.mouseEnter(screen.getByTestId('zone'))
  })
  move('zone')
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
  useUIStore.setState({ sidebarDocking: 'hover', sidebarPeek: false, sidebarOpen: true })
})

afterEach(() => {
  for (const el of added) el.remove()
  added = []
  vi.useRealTimers()
})

describe('useSidebarHoverDock', () => {
  it('peeks after the pointer rests at the edge, and not before', () => {
    render(<Harness />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId('zone'))
    })
    advance(PEEK_OPEN_DELAY_MS - 1)
    expect(peek()).toBe(false)
    advance(1)
    expect(peek()).toBe(true)
  })

  it('does not peek when the pointer leaves the edge before the dwell', () => {
    render(<Harness />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId('zone'))
    })
    advance(PEEK_OPEN_DELAY_MS - 20)
    act(() => {
      fireEvent.mouseLeave(screen.getByTestId('zone'))
    })
    advance(PEEK_OPEN_DELAY_MS * 5)
    expect(peek()).toBe(false)
  })

  it('does nothing in fixed docking', () => {
    useUIStore.setState({ sidebarDocking: 'fixed' })
    render(<Harness />)
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId('zone'))
    })
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
    act(() => {
      fireEvent.mouseEnter(screen.getByTestId('zone'))
    })
    move('zone')
    advance(PEEK_OPEN_DELAY_MS)
    act(() => {
      fireEvent.mouseOut(screen.getByTestId('sidebar'), { relatedTarget: null })
    })
    advance(PEEK_CLOSE_DELAY_MS)
    expect(peek()).toBe(false)
  })

  it('stays while a menu is open, and hides once it has closed', () => {
    render(<Harness />)
    const menu = addToBody(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    openThenLeave()
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
    const popover = addToBody(document.createElement('div'))
    popover.className = 'app-popover-surface'
    // Not portaled into body: a toast in the shell must not hold the sidebar.
    const toast = document.createElement('div')
    toast.className = 'app-popover-surface'
    screen.getByTestId('main').appendChild(toast)
    openThenLeave()
    advance(PEEK_CLOSE_DELAY_MS * 4)
    expect(peek()).toBe(true)
    popover.remove()
    advance(PEEK_BLOCK_POLL_MS + PEEK_CLOSE_DELAY_MS)
    expect(peek()).toBe(false)
  })

  it('stays while a dialog is open', () => {
    render(<Harness />)
    const dialog = addToBody(document.createElement('div'))
    dialog.setAttribute('aria-modal', 'true')
    openThenLeave()
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
    const menu = addToBody(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    openThenLeave()
    advance(PEEK_CLOSE_DELAY_MS * 2)
    move('sidebar')
    menu.remove()
    advance(PEEK_CLOSE_DELAY_MS * 10)
    expect(peek()).toBe(true)
  })
})
