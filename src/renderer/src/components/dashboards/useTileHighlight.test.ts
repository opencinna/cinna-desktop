import { describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { revealHighlight } = await import('./useTileHighlight')

const rect = (top: number, bottom: number): DOMRect => ({ top, bottom }) as DOMRect

/** A tile with a scrolling box from y 0, one highlighted row at `rowTop`, and a header ending at `headerBottom`. */
function tile(rowTop: number, headerBottom: number | null): { tile: HTMLElement; box: HTMLElement } {
  const root = document.createElement('div')
  const box = document.createElement('div')
  Object.defineProperty(box, 'scrollHeight', { value: 500 })
  Object.defineProperty(box, 'clientHeight', { value: 200 })
  box.scrollTop = 100
  box.getBoundingClientRect = () => rect(0, 200)
  const row = document.createElement('div')
  row.setAttribute('data-highlighted', 'true')
  row.getBoundingClientRect = () => rect(rowTop, rowTop + 20)
  box.append(row)
  root.append(box)
  if (headerBottom !== null) {
    const header = document.createElement('div')
    header.setAttribute('data-tile-header', '')
    header.getBoundingClientRect = () => rect(headerBottom - 34, headerBottom)
    root.append(header)
  }
  return { tile: root, box }
}

describe('revealHighlight', () => {
  it('brings a row out from under a floating header', () => {
    // Mutation: compare with the box's top alone and a row at y 10 counts as shown, behind the bar.
    const { tile: root, box } = tile(10, 34)
    expect(revealHighlight(root, 0)).toBe(true)
    expect(box.scrollTop).toBe(76)
  })

  it('a header above the scrolling box, or parked off the tile, changes nothing', () => {
    const shown = tile(10, -34)
    revealHighlight(shown.tile, 0)
    expect(shown.box.scrollTop).toBe(100)
    const above = tile(-30, 0)
    revealHighlight(above.tile, 0)
    expect(above.box.scrollTop).toBe(70)
  })
})
