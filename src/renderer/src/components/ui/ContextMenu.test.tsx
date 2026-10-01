import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu } from './ContextMenu'

/**
 * Where the menu sits when its content changes after opening — a refused
 * pick's reason, or an item whose condition resolves late. A menu pushed up to
 * fit keeps its bottom edge and grows upward; one that opened downward keeps
 * its top. Either way the item under the pointer stays the one it was.
 */

const menuHeight = { current: 100 }

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.getAttribute('role') === 'menu' ? menuHeight.current : 0
    return { x: 0, y: 0, left: 0, top: 0, right: 176, bottom: height, width: 176, height, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  menuHeight.current = 100
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
