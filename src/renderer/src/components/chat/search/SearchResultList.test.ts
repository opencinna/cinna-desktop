import { describe, expect, it } from 'vitest'
import { railLayout } from './SearchResultList'

/**
 * The dot rail's sizes: whatever the number of results and chats, the rail
 * is never taller than the list beside it.
 */

/** The rail's drawn height: every dot and the gap after it, plus a chat break's extra gap. */
const railHeight = (height: number, count: number, breaks: number): number => {
  const { dot, gap, groupGap } = railLayout(height, count, breaks)
  return count * dot + (count - 1) * gap + breaks * groupGap
}

describe('railLayout', () => {
  it('keeps the full pitch while there is room', () => {
    expect(railLayout(600, 5, 1)).toEqual({ dot: expect.closeTo(5.58, 2), gap: expect.closeTo(3.42, 2), groupGap: 9 })
  })

  it.each([
    // 50 chats of one to three matches: the case that ran past the window.
    [760, 150, 49],
    [760, 100, 49],
    [300, 60, 20],
    [120, 50, 49],
    [800, 3, 2]
  ])('fits %ipx with %i dots and %i chat breaks', (height, count, breaks) => {
    expect(railHeight(height, count, breaks)).toBeLessThanOrEqual(height)
  })

  it('counts the chat breaks in the pitch', () => {
    // 50 dots and 49 breaks in 500px: 99 pitches, not 50.
    const { dot, gap, groupGap } = railLayout(500, 50, 49)
    expect(dot + gap).toBeCloseTo(500 / 99, 5)
    expect(groupGap).toBeCloseTo(500 / 99, 5)
  })

  it('drops the chat breaks when keeping them would make the dots too fine', () => {
    expect(railLayout(300, 150, 49).groupGap).toBe(0)
  })
})
