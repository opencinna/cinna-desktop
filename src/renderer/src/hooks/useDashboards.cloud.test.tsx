import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAddTile, useCloudComponents, useRemoveTile } from './useDashboards'

/**
 * A cloud agent's Dashboards tab (D6) lists its components with this
 * profile's tiles of them; adding or removing a tile must re-read it, or the
 * tab says "Not on a dashboard yet." for a component the user just placed.
 */

const cloudComponents = vi.fn()
const addTile = vi.fn()
const removeTile = vi.fn()

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cloudComponents.mockReset().mockResolvedValue({ ok: true, components: [], placements: [] })
  addTile.mockReset().mockResolvedValue({ ok: true, tile: { id: 't1' }, dashboard: { id: 'd1' } })
  removeTile.mockReset().mockResolvedValue({ ok: true })
  window.api = { dashboards: { cloudComponents, addTile, removeTile } } as never
})

function useTab() {
  return { components: useCloudComponents('remote-row-1'), add: useAddTile(), remove: useRemoveTile() }
}

describe('a cloud agent’s components and placements', () => {
  it('are read again after a tile is added', async () => {
    // Mutation: move `cloudComponentsKey` out from under `['dashboards','placements']` and the add leaves it stale.
    const { result } = renderHook(useTab, { wrapper })
    await waitFor(() => expect(result.current.components.isSuccess).toBe(true))
    expect(cloudComponents).toHaveBeenCalledTimes(1)
    await act(async () => {
      await result.current.add.mutateAsync({ dashboardId: 'd1', agentId: 'remote-row-1', component: 'deals' })
    })
    await waitFor(() => expect(cloudComponents).toHaveBeenCalledTimes(2))
  })

  it('are read again after a tile is removed', async () => {
    const { result } = renderHook(useTab, { wrapper })
    await waitFor(() => expect(result.current.components.isSuccess).toBe(true))
    await act(async () => {
      await result.current.remove.mutateAsync('t1')
    })
    await waitFor(() => expect(cloudComponents).toHaveBeenCalledTimes(2))
  })
})
