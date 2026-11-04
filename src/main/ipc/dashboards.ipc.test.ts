import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The dashboards highlight channels (D5): gated on activation, and only for
 * a tile of the active profile — another profile's tile, or anything that is
 * not a tile id, reads as nothing held and changes nothing.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))
const requireActivated = vi.hoisted(() => vi.fn())
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile-1' }))
const tilesOf = vi.hoisted(() => ({ 'profile-1': { 'tile-list': 'list', 'tile-page': 'html' } as Record<string, string> }))
const resolveTile = vi.hoisted(() => vi.fn((userId: string, tileId: unknown) => {
  const view = typeof tileId === 'string' ? (tilesOf as Record<string, Record<string, string>>)[userId]?.[tileId] : undefined
  return view ? { tile: { id: tileId }, scanned: { spec: { view } } } : null
}))
vi.mock('../services/dashboards/dashboardService', () => ({ dashboardService: { resolveTile } }))
vi.mock('../services/dashboards/dashboardRefreshService', () => ({ dashboardRefreshService: {} }))
vi.mock('../services/dashboards/panelChat', () => ({ panelChatService: {} }))
vi.mock('../host/desktop/htmlPreview', () => ({ dashboardFrameServer: {} }))

const { tileHighlights } = await import('../services/dashboards/tileHighlights')
const { registerDashboardHandlers } = await import('./dashboards.ipc')
registerDashboardHandlers()

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

beforeEach(() => {
  requireActivated.mockReset()
  resolveTile.mockClear()
  tileHighlights.reset()
})

describe('dashboards highlight IPC', () => {
  it('reads and clears the held highlight of an active profile’s tile', async () => {
    tileHighlights.set('tile-list', ['d-1', 'd-2'])
    expect(await call('dashboards:highlight', 'tile-list')).toEqual(['d-1', 'd-2'])
    expect(resolveTile).toHaveBeenCalledWith('profile-1', 'tile-list')
    expect(await call('dashboards:clear-highlight', 'tile-list')).toBe(true)
    expect(await call('dashboards:highlight', 'tile-list')).toEqual([])
    expect(requireActivated).toHaveBeenCalledTimes(3)
  })

  it('answers nothing and changes nothing for a tile that is not the active profile’s, or no tile id', async () => {
    tileHighlights.set('tile-other', ['x'])
    expect(await call('dashboards:highlight', 'tile-other')).toEqual([])
    expect(await call('dashboards:clear-highlight', 'tile-other')).toBe(false)
    expect(tileHighlights.get('tile-other')).toEqual(['x'])
    for (const bad of [undefined, 7, { tileId: 'tile-list' }]) {
      expect(await call('dashboards:highlight', bad)).toEqual([])
      expect(await call('dashboards:clear-highlight', bad)).toBe(false)
      expect(await call('dashboards:highlight-ready', bad)).toBe(false)
    }
  })

  it('marks only a page tile of the active profile as ready to highlight', async () => {
    expect(await call('dashboards:highlight-ready', 'tile-page')).toBe(true)
    expect(tileHighlights.isReady('tile-page')).toBe(true)
    expect(await call('dashboards:highlight-ready', 'tile-list')).toBe(false)
    expect(await call('dashboards:highlight-ready', 'tile-other')).toBe(false)
    expect(tileHighlights.isReady('tile-list')).toBe(false)
    expect(tileHighlights.isReady('tile-other')).toBe(false)
  })

  it('forgets a page tile is ready when its page loads again', async () => {
    expect(await call('dashboards:highlight-ready', 'tile-page')).toBe(true)
    expect(await call('dashboards:highlight-ready', 'tile-page', false)).toBe(true)
    expect(tileHighlights.isReady('tile-page')).toBe(false)
    expect(await call('dashboards:highlight-ready', 'tile-other', false)).toBe(false)
  })

  it('refuses every channel before activation', async () => {
    requireActivated.mockImplementation(() => { throw new Error('not activated') })
    for (const channel of ['dashboards:highlight', 'dashboards:clear-highlight', 'dashboards:highlight-ready']) {
      expect(() => call(channel, 'tile-page')).toThrow('not activated')
    }
    expect(tileHighlights.isReady('tile-page')).toBe(false)
  })
})
