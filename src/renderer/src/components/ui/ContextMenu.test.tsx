import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu } from './ContextMenu'

/**
 * Where the menu sits when its content changes after opening — a refused
 * pick's reason, or an item whose condition resolves late. A menu pushed up to
 * fit keeps its bottom edge and grows upward; one that opened downward keeps
 * its top. Either way the item under the pointer stays the one it was.
 */

const menuHeight = { current: 100 }
/** The top of an element marked `data-test-anchor`, a 24px trigger at x 500. */
const anchorTop = { current: 300 }

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testAnchor !== undefined) {
      const top = anchorTop.current
      return { x: 500, y: top, left: 500, top, right: 524, bottom: top + 24, width: 24, height: 24, toJSON: () => ({}) } as DOMRect
    }
    const height = this.getAttribute('role') === 'menu' ? menuHeight.current : 0
    return { x: 0, y: 0, left: 0, top: 0, right: 176, bottom: height, width: 176, height, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  menuHeight.current = 100
  anchorTop.current = 300
})

const menu = (error: string | null, y: number): React.JSX.Element => (
  <ContextMenu x={40} y={y} anchor={null} label="Agent Planner" error={error} onClose={() => undefined}>
    <button type="button" role="menuitem">Set as Coordinator</button>
  </ContextMenu>
)

describe('ContextMenu placement', () => {
  it('keeps the bottom edge of a menu pushed up to fit when an error line grows it', () => {
    const { rerender } = render(menu(null, 560))
    const el = screen.getByRole('menu')
    expect(el.style.bottom).toBe('8px')
    expect(el.style.top).toBe('')

    menuHeight.current = 164
    rerender(menu('Interrupt the session before changing who answers.', 560))
    expect(el.style.bottom).toBe('8px')
    expect(el.style.top).toBe('')
    // Growing upward, the reason goes above the items: the one clicked stays put.
    expect(el.firstElementChild?.getAttribute('role')).toBe('alert')
  })

  it('keeps the top edge of a menu that opened downward', () => {
    const { rerender } = render(menu(null, 100))
    const el = screen.getByRole('menu')
    expect(el.style.top).toBe('100px')

    menuHeight.current = 164
    rerender(menu('The folder is gone.', 100))
    expect(el.style.top).toBe('100px')
    expect(el.style.bottom).toBe('')
    expect(el.lastElementChild?.getAttribute('role')).toBe('alert')
  })

  it('anchors the bottom once growth would push a downward menu past the window', () => {
    const { rerender } = render(menu(null, 400))
    const el = screen.getByRole('menu')
    expect(el.style.top).toBe('400px')

    menuHeight.current = 240
    rerender(menu('The folder is gone.', 400))
    expect(el.style.bottom).toBe('8px')
    expect(el.style.top).toBe('')
  })

  it('returns a menu pushed up by an error to where it opened once the error clears', () => {
    const { rerender } = render(menu(null, 400))
    const el = screen.getByRole('menu')
    expect(el.style.top).toBe('400px')

    menuHeight.current = 240
    rerender(menu('The folder is gone.', 400))
    expect(el.style.bottom).toBe('8px')

    menuHeight.current = 100
    rerender(menu(null, 400))
    expect(el.style.top).toBe('400px')
    expect(el.style.bottom).toBe('')
  })
})

describe('ContextMenu opened from a button', () => {
  it('puts its right edge at x when aligned right, still inside the window', () => {
    const { rerender } = render(
      <ContextMenu x={500} y={100} anchor={null} label="Actions" align="right" onClose={() => undefined}>
        <button type="button" role="menuitem">Remove</button>
      </ContextMenu>
    )
    expect(screen.getByRole('menu').style.left).toBe(`${500 - 176}px`)
    rerender(
      <ContextMenu x={100} y={100} anchor={null} label="Actions" align="right" onClose={() => undefined}>
        <button type="button" role="menuitem">Remove</button>
      </ContextMenu>
    )
    expect(screen.getByRole('menu').style.left).toBe('8px')
  })

  it('keeps a press and Escape inside the menu from reaching a dialog listening on the window', () => {
    const onClose = vi.fn()
    const windowMouseDown = vi.fn()
    const windowEscape = vi.fn()
    window.addEventListener('mousedown', windowMouseDown)
    window.addEventListener('keydown', windowEscape)
    try {
      render(
        <ContextMenu x={40} y={40} anchor={null} label="Actions" onClose={onClose}>
          <button type="button" role="menuitem">Remove</button>
        </ContextMenu>
      )
      const item = screen.getByRole('menuitem', { name: 'Remove' })
      fireEvent.mouseDown(item)
      expect(windowMouseDown).not.toHaveBeenCalled()
      fireEvent.keyDown(item, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(windowEscape).not.toHaveBeenCalled()
      // Outside the menu, a press still reaches the window.
      fireEvent.mouseDown(document.body)
      expect(windowMouseDown).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('mousedown', windowMouseDown)
      window.removeEventListener('keydown', windowEscape)
    }
  })
})

/**
 * A scroll event can reach the menu after it opened for a scroll that had
 * already ended (Playwright's scroll into view before its click, momentum
 * settling). Only a scroll that moves the anchor closes the menu.
 */
describe('ContextMenu and a scroll of the pane holding its anchor', () => {
  const added: HTMLElement[] = []
  afterEach(() => {
    for (const node of added.splice(0)) node.remove()
  })

  const setup = (): { pane: HTMLElement; other: HTMLElement; onClose: ReturnType<typeof vi.fn> } => {
    const pane = document.createElement('div')
    const anchor = document.createElement('button')
    anchor.dataset.testAnchor = ''
    pane.appendChild(anchor)
    const other = document.createElement('div')
    document.body.append(pane, other)
    added.push(pane, other)
    const onClose = vi.fn()
    render(
      <ContextMenu x={500} y={324} anchor={anchor} label="Actions" onClose={onClose}>
        <button type="button" role="menuitem">Remove access…</button>
      </ContextMenu>
    )
    return { pane, other, onClose }
  }


  it('stays open for a scroll that leaves the anchor where it was when the menu opened', () => {
    const { pane, onClose } = setup()
    fireEvent.scroll(pane)
    // Sub-pixel drift is not a move.
    anchorTop.current = 300.5
    fireEvent.scroll(pane)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeTruthy()
  })

  it('closes on a scroll that moves the anchor', () => {
    const { pane, onClose } = setup()
    anchorTop.current = 260
    fireEvent.scroll(pane)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores a scroll of a pane that does not hold the anchor, even while the anchor moves', () => {
    const { other, onClose } = setup()
    anchorTop.current = 260
    fireEvent.scroll(other)
    expect(onClose).not.toHaveBeenCalled()
  })
})
