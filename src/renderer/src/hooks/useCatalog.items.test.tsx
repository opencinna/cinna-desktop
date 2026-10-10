import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createElement, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogItemsListing } from '../../../shared/catalogItems'

/**
 * One query holds the catalog's items for every surface: the composer picker
 * reads what main has cached, while the dialog and Settings → Catalog list
 * again. Which of them rendered last must not decide whether a re-read while a
 * listing surface is open lists again.
 */

const { useAuthStore } = await import('../stores/auth.store')
const { catalogItemsKey, useCatalogItems } = await import('./useCatalog')

const LISTING: CatalogItemsListing = { host: 'https://core.test', fetchedAt: '2026-10-10T00:00:00Z', available: true, items: [] }

let items: ReturnType<typeof vi.fn>

beforeEach(() => {
  useAuthStore.setState({
    currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false } as never
  })
  items = vi.fn().mockResolvedValue({ success: true, value: LISTING })
  ;(window as unknown as { api: unknown }).api = { catalog: { items } }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** The dialog (or Settings) and the composer picker, the picker rendering after it. */
function Surfaces({ dialog }: { dialog: boolean }): React.JSX.Element {
  return createElement('div', null, dialog ? createElement(Dialog) : null, createElement(Picker))
}
function Dialog(): null {
  useCatalogItems({ refresh: true })
  return null
}
function Picker(): null {
  // Re-rendering the picker alone must not change what the query fetches.
  const [, setTick] = useState(0)
  rerenderPicker = () => setTick((n) => n + 1)
  useCatalogItems({ refresh: false })
  return null
}
let rerenderPicker: () => void = () => {}

function mount(dialog: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(createElement(QueryClientProvider, { client }, createElement(Surfaces, { dialog })))
  return { client, view }
}

describe('useCatalogItems', () => {
  it('lists again on a re-read while a listing surface is open, whichever observer rendered last', async () => {
    const { client } = mount(true)
    await waitFor(() => expect(items).toHaveBeenCalled())
    expect(items).toHaveBeenLastCalledWith(true)
    await waitFor(() => expect(client.getQueryState(catalogItemsKey('p1'))?.fetchStatus).toBe('idle'))
    act(() => rerenderPicker())
    items.mockClear()
    await act(() => client.invalidateQueries({ queryKey: ['catalog'] }))
    expect(items).toHaveBeenCalledTimes(1)
    expect(items).toHaveBeenLastCalledWith(true)
  })

  it('reads main’s cache when only the picker is open', async () => {
    const { client } = mount(false)
    await waitFor(() => expect(items).toHaveBeenCalled())
    expect(items).toHaveBeenLastCalledWith(false)
    await waitFor(() => expect(client.getQueryState(catalogItemsKey('p1'))?.fetchStatus).toBe('idle'))
    items.mockClear()
    await act(() => client.invalidateQueries({ queryKey: ['catalog'] }))
    expect(items).toHaveBeenCalledTimes(1)
    expect(items).toHaveBeenLastCalledWith(false)
  })

  it('stops listing again once the listing surface closes', async () => {
    const { client, view } = mount(true)
    await waitFor(() => expect(client.getQueryState(catalogItemsKey('p1'))?.fetchStatus).toBe('idle'))
    view.rerender(
      createElement(QueryClientProvider, { client }, createElement(Surfaces, { dialog: false }))
    )
    items.mockClear()
    await act(() => client.invalidateQueries({ queryKey: ['catalog'] }))
    expect(items).toHaveBeenCalledTimes(1)
    expect(items).toHaveBeenLastCalledWith(false)
  })

  it('a listing surface opening while the picker’s cache read is on its way lists again', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(createElement(QueryClientProvider, { client }, createElement(Surfaces, { dialog: false })))
    await waitFor(() => expect(client.getQueryState(catalogItemsKey('p1'))?.fetchStatus).toBe('idle'))
    // A re-read (an invalidation, window focus) the picker started, still on its way.
    let answerCacheRead: (value: unknown) => void = () => {}
    items.mockImplementationOnce(() => new Promise((resolve) => (answerCacheRead = resolve)))
    void client.invalidateQueries({ queryKey: ['catalog'] })
    await waitFor(() => expect(client.getQueryState(catalogItemsKey('p1'))?.fetchStatus).toBe('fetching'))
    expect(items).toHaveBeenLastCalledWith(false)
    view.rerender(createElement(QueryClientProvider, { client }, createElement(Surfaces, { dialog: true })))
    await waitFor(() => expect(items).toHaveBeenLastCalledWith(true))
    answerCacheRead({ success: true, value: LISTING })
    await waitFor(() => expect(client.getQueryState(catalogItemsKey('p1'))?.fetchStatus).toBe('idle'))
  })

  it('opening a listing surface on an idle query lists once', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(createElement(QueryClientProvider, { client }, createElement(Surfaces, { dialog: false })))
    await waitFor(() => expect(client.getQueryState(catalogItemsKey('p1'))?.fetchStatus).toBe('idle'))
    items.mockClear()
    view.rerender(createElement(QueryClientProvider, { client }, createElement(Surfaces, { dialog: true })))
    await waitFor(() => expect(client.getQueryState(catalogItemsKey('p1'))?.fetchStatus).toBe('idle'))
    expect(items).toHaveBeenCalledTimes(1)
    expect(items).toHaveBeenLastCalledWith(true)
  })
})
