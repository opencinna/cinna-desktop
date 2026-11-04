import { act, render } from '@testing-library/react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'
import { headerPlacement } from './ChatTable'

const TABLE = '| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |'

/** jsdom lays nothing out: a table's widths are whatever the test says they are. */
let widths = { scrollWidth: 300, clientWidth: 300 }
const scrollDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
const clientDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => widths.scrollWidth })
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => widths.clientWidth })

let resize: (() => void) | null = null
class FakeResizeObserver {
  constructor(callback: () => void) { resize = callback }
  observe(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

afterEach(() => {
  widths = { scrollWidth: 300, clientWidth: 300 }
  resize = null
})

describe('ChatTable', () => {
  it('leaves a table that fits unmarked, so its header can stick', () => {
    const { container } = render(<MessageBubble role="assistant" content={TABLE} />)
    const table = container.querySelector('table')
    expect(table).toBeTruthy()
    expect(table?.hasAttribute('data-table-scrolls')).toBe(false)
    expect(container.querySelectorAll('th')).toHaveLength(2)
  })

  it('marks a table wider than its box so it keeps its own sideways scroll', () => {
    widths = { scrollWidth: 900, clientWidth: 400 }
    const { container } = render(<MessageBubble role="assistant" content={TABLE} />)
    expect(container.querySelector('table')?.hasAttribute('data-table-scrolls')).toBe(true)
  })

  it('re-measures when its box resizes, both ways', () => {
    const { container } = render(<MessageBubble role="assistant" content={TABLE} />)
    const table = container.querySelector('table') as HTMLTableElement
    widths = { scrollWidth: 900, clientWidth: 400 }
    act(() => resize?.())
    expect(table.hasAttribute('data-table-scrolls')).toBe(true)
    widths = { scrollWidth: 900, clientWidth: 900 }
    act(() => resize?.())
    expect(table.hasAttribute('data-table-scrolls')).toBe(false)
  })

  it('re-measures as a streamed table grows', () => {
    const { container, rerender } = render(<MessageBubble role="assistant" content={TABLE} isStreaming />)
    expect(container.querySelector('table')?.hasAttribute('data-table-scrolls')).toBe(false)
    widths = { scrollWidth: 900, clientWidth: 400 }
    rerender(<MessageBubble role="assistant" content={TABLE + '\n| a-very-long-unbreakable-token | 3 |'} isStreaming />)
    expect(container.querySelector('table')?.hasAttribute('data-table-scrolls')).toBe(true)
  })

  it('ignores a one-pixel rounding overshoot', () => {
    widths = { scrollWidth: 301, clientWidth: 300 }
    const { container } = render(<MessageBubble role="assistant" content={TABLE} />)
    expect(container.querySelector('table')?.hasAttribute('data-table-scrolls')).toBe(false)
  })
})

afterAll(() => {
  if (scrollDesc) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollDesc)
  if (clientDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientDesc)
  vi.unstubAllGlobals()
})

describe('headerPlacement', () => {
  it('is not stuck while the header sits at the table top', () => {
    expect(headerPlacement(100, 30, 100, 400)).toEqual({ stuck: false, shift: 0 })
  })

  it('is stuck once sticky has moved it down the table, with no shift while rows remain under it', () => {
    expect(headerPlacement(36, 30, -200, 300)).toEqual({ stuck: true, shift: 0 })
  })

  it('slides up with the last row once that row reaches the header bottom', () => {
    // Header 36..66; the last row's top at 50 pushes it up 16px.
    expect(headerPlacement(36, 30, -800, 50)).toEqual({ stuck: true, shift: -16 })
  })

  it('never shifts a header with no body rows, nor one at rest', () => {
    expect(headerPlacement(36, 30, -100, null)).toEqual({ stuck: true, shift: 0 })
    expect(headerPlacement(100, 30, 100, 110)).toEqual({ stuck: false, shift: 0 })
  })
})
