import { describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { GRID_MIN_WIDTH, PANEL_MIN_WIDTH, panelLayout } = await import('./DashboardChatPanel')

describe('panelLayout (the chat panel on every resize)', () => {
  it('keeps the user’s width while the grid keeps its minimum', () => {
    expect(panelLayout(1400, 400, 1600)).toEqual({ width: 400, maxWidth: 960, overlay: false })
  })

  it('narrows the panel as the window shrinks, so the grid keeps 360 px', () => {
    const layout = panelLayout(800, 600, 1000)
    expect(layout).toMatchObject({ width: 800 - GRID_MIN_WIDTH, overlay: false })
    // Never below the panel's minimum while side by side.
    expect(panelLayout(GRID_MIN_WIDTH + PANEL_MIN_WIDTH, 600, 900)).toMatchObject({ width: PANEL_MIN_WIDTH, overlay: false })
  })

  it('lies over the grid at its minimum when grid 360 + panel 300 do not fit, so the grid stays reachable', () => {
    // Mutation: use the stored width here and a 400 px panel covers all but 108 px of a 508 px row.
    expect(panelLayout(508, 400, 800)).toEqual({ width: PANEL_MIN_WIDTH, maxWidth: PANEL_MIN_WIDTH, overlay: true })
    expect(panelLayout(500, 900, 800)).toMatchObject({ width: PANEL_MIN_WIDTH, overlay: true })
    expect(panelLayout(280, 400, 400)).toMatchObject({ width: 280, overlay: true })
  })

  it('gives the stored width back when the window grows again', () => {
    expect(panelLayout(700, 500, 900).width).toBe(340)
    expect(panelLayout(1400, 500, 1600).width).toBe(500)
  })

  it('an unmeasured row constrains nothing but the window fraction', () => {
    expect(panelLayout(null, 400, 1280)).toMatchObject({ width: 400, overlay: false })
  })
})
