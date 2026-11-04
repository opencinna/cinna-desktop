import { describe, expect, it } from 'vitest'
import { filtersThatFit } from './TileFilters'

describe('filtersThatFit', () => {
  it('fits all when they fit, without room for the button', () => {
    expect(filtersThatFit(324, [100, 100, 100], 60)).toBe(3)
  })
  it('otherwise fits the first ones that leave room for Filters ⋯', () => {
    expect(filtersThatFit(323, [100, 100, 100], 60)).toBe(2)
    expect(filtersThatFit(171, [100, 100], 60)).toBe(0)
    expect(filtersThatFit(172, [100, 100], 60)).toBe(1)
  })
  it('stops at the first that does not fit, keeping the order', () => {
    expect(filtersThatFit(300, [50, 400, 50], 60)).toBe(1)
  })
  it('treats unmeasured widths as fitting', () => {
    expect(filtersThatFit(100, [0, 0, 0], 0)).toBe(3)
  })
})
