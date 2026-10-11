import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeChoiceButtons } from './RuntimeChoiceButtons'

const props = { selected: 'claude' as const, tools: [], installing: null, onSelect: vi.fn(), onInstall: vi.fn() }

/**
 * jsdom does no layout, so the shape is asserted where it is decided: the
 * buttons sit in a grid of equal columns and none of them grows to fill a row.
 * A wrapping flex row with `flex-1` laid four buttons out as three plus one
 * stretched across the whole second row (ux_rules rule 12).
 */
function expectEqualCells(count: number, wide: string): void {
  const buttons = screen.getAllByRole('button')
  expect(buttons).toHaveLength(count)
  const grid = buttons[0].parentElement!
  expect(buttons.every((button) => button.parentElement === grid)).toBe(true)
  expect(grid.className).toMatch(/\bgrid\b/)
  expect(grid.className).toContain('grid-cols-2')
  expect(grid.className).toContain(wide)
  expect(grid.className).not.toContain('flex-wrap')
  expect(grid.parentElement!.className).toContain('@container')
  for (const button of buttons) {
    expect(button.className).not.toMatch(/\bflex-1\b/)
    expect(button.className).not.toMatch(/min-w-\[/)
  }
}

describe('RuntimeChoiceButtons', () => {
  it('lays the four runtimes out as equal cells, two a row or all four', () => {
    render(<RuntimeChoiceButtons {...props} />)
    expectEqualCells(4, '@2xl:grid-cols-4')
  })

  it('does the same with Default Runtime as a fifth choice, three a row before all five', () => {
    render(<RuntimeChoiceButtons {...props} defaultChoice={{ description: 'Claude Agent', onSelect: vi.fn() }} />)
    expectEqualCells(5, '@xl:grid-cols-3 @4xl:grid-cols-5')
  })
})
