import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_TILES_POLL_MS } from '../../../shared/dashboards'
import { useDashboardTiles } from './useDashboards'

/**
 * Main re-reads a cloud agent's component list only when asked for a
 * dashboard's tiles. An open dashboard holding a cloud tile must keep asking,
 * or a component broken or fixed elsewhere (the CLI, the web) keeps its old
 * state until the dashboard is reopened.
 */

const tiles = vi.fn()
let client: QueryClient

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function answer(cloud: boolean) {
  const tile = cloud ? { id: 't1', cloud: { remoteAgentId: 'r1', server: 'core.test' } } : { id: 't1' }
  return { ok: true, dashboard: { id: 'd1' }, tiles: [{ tile, displayTitle: 'Deals', state: 'ok', component: null, schedule: null }] }
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  tiles.mockReset()
  window.api = { dashboards: { tiles } } as never
})

afterEach(() => {
  client.clear()
  vi.useRealTimers()
})

describe('an open dashboard', () => {
  it('asks for its tiles again every poll period while it holds a cloud tile', async () => {
    // Mutation: drop `refetchInterval` from useDashboardTiles and this stays at one call.
    tiles.mockResolvedValue(answer(true))
    renderHook(() => useDashboardTiles('d1'), { wrapper })
    await settle(0)
    expect(tiles).toHaveBeenCalledTimes(1)
    await settle(CLOUD_TILES_POLL_MS)
    expect(tiles).toHaveBeenCalledTimes(2)
    await settle(CLOUD_TILES_POLL_MS)
    expect(tiles).toHaveBeenCalledTimes(3)
  })

  it('does not poll when every tile is a local one', async () => {
    tiles.mockResolvedValue(answer(false))
    renderHook(() => useDashboardTiles('d1'), { wrapper })
    await settle(0)
    await settle(CLOUD_TILES_POLL_MS * 8)
    expect(tiles).toHaveBeenCalledTimes(1)
  })
})
