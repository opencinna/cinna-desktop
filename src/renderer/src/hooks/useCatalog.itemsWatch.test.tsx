import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogItem, CatalogItemsListing } from '../../../shared/catalogItems'

/**
 * Main tells the renderer the catalog listing moved in two ways: the heavy
 * `sharing:changed` when a desktop agent moved (every sharing read re-reads,
 * git status per shared agent among them), and the light
 * `catalog:items-changed` for any other item (a cloud install, a skill's new
 * version). The light one must touch nothing of team sharing, and neither
 * may make the open dialog list the catalog again — main has just done that.
 */

const { useAuthStore } = await import('../stores/auth.store')
const { catalogItemsKey, useCatalogItems, useCatalogItemsWatch } = await import('./useCatalog')
const { useSharingWatch } = await import('./useSharing')

const ok = <T,>(value: T) => ({ success: true as const, value })

function listing(names: string[]): CatalogItemsListing {
  return {
    host: 'https://core.test',
    fetchedAt: '2026-10-10T00:00:00Z',
    available: true,
    items: names.map((name) => ({ kind: 'skill', runs_on: null, uuid: `u-${name}`, id: name, name }) as unknown as CatalogItem)
  }
}

let items: ReturnType<typeof vi.fn>
let pushItemsChanged: () => void
let pushSharingChanged: () => void

beforeEach(() => {
  useAuthStore.setState({
    currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false } as never
  })
  items = vi.fn().mockResolvedValue(ok(listing(['first'])))
  ;(window as unknown as { api: unknown }).api = {
    catalog: {
      items,
      onItemsChanged: vi.fn((handler: () => void) => {
        pushItemsChanged = handler
        return () => {}
      })
    },
    sharing: {
      onChanged: vi.fn((handler: () => void) => {
        pushSharingChanged = handler
        return () => {}
      })
    },
    localAgents: { onChanged: vi.fn(() => () => {}) }
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mount(): { client: QueryClient; seen: { names?: string[] } } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const seen: { names?: string[] } = {}
  function Page(): null {
    useSharingWatch()
    useCatalogItemsWatch()
    // The dialog's read: lists again when it opens.
    seen.names = useCatalogItems({ refresh: true }).data?.items.map((item) => item.name)
    return null
  }
  render(createElement(QueryClientProvider, { client }, createElement(Page)))
  return { client, seen }
}

describe('catalog:items-changed', () => {
  it('re-reads the dialog’s items from main’s cache and the Inbox, never the sharing reads', async () => {
    const { client, seen } = mount()
    await waitFor(() => expect(seen.names).toEqual(['first']))
    expect(items.mock.calls).toEqual([[true]])
    client.setQueryData(['sharing', 'statuses', 'p1'], [])
    client.setQueryData(['inbox'], { entries: [] })

    items.mockResolvedValue(ok(listing(['first', 'second'])))
    pushItemsChanged()
    await waitFor(() => expect(seen.names).toEqual(['first', 'second']))
    // From the cache: no second listing of the catalog.
    expect(items.mock.calls).toEqual([[true], [false]])
    expect(client.getQueryState(['sharing', 'statuses', 'p1'])?.isInvalidated).toBe(false)
    expect(client.getQueryState(['inbox'])?.isInvalidated).toBe(true)
  })

  it('re-reads the folder agents, whose Skills rows show Update from the listing', () => {
    const client = new QueryClient()
    function Page(): null {
      useCatalogItemsWatch()
      return null
    }
    render(createElement(QueryClientProvider, { client }, createElement(Page)))
    client.setQueryData(['local-agents'], { roots: [], agents: [] })
    client.setQueryData(['local-agent', 'a1'], { id: 'a1' })
    client.setQueryData(['local-agent-doc', 'a1', 'readme'], { text: '' })
    pushItemsChanged()
    expect(client.getQueryState(['local-agents'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['local-agent', 'a1'])?.isInvalidated).toBe(true)
    // The documents are files; a listing move does not touch them.
    expect(client.getQueryState(['local-agent-doc', 'a1', 'readme'])?.isInvalidated).toBe(false)
  })

  it('reads nothing when no catalog read is cached', () => {
    const client = new QueryClient()
    function Page(): null {
      useCatalogItemsWatch()
      return null
    }
    render(createElement(QueryClientProvider, { client }, createElement(Page)))
    pushItemsChanged()
    expect(items).not.toHaveBeenCalled()
    expect(client.getQueryState(catalogItemsKey('p1'))).toBeUndefined()
  })
})

describe('sharing:changed', () => {
  it('re-reads the sharing reads, and the dialog’s items from main’s cache without listing again', async () => {
    const { client, seen } = mount()
    await waitFor(() => expect(seen.names).toEqual(['first']))
    client.setQueryData(['sharing', 'statuses', 'p1'], [])

    items.mockResolvedValue(ok(listing(['first', 'desktop'])))
    pushSharingChanged()
    await waitFor(() => expect(seen.names).toEqual(['first', 'desktop']))
    expect(items.mock.calls).toEqual([[true], [false]])
    expect(client.getQueryState(['sharing', 'statuses', 'p1'])?.isInvalidated).toBe(true)
  })

  it('re-reads the folder agents too: a skill version can arrive with a desktop agent’s move', () => {
    const client = new QueryClient()
    function Page(): null {
      useSharingWatch()
      return null
    }
    render(createElement(QueryClientProvider, { client }, createElement(Page)))
    client.setQueryData(['local-agents'], { roots: [], agents: [] })
    client.setQueryData(['local-agent', 'a1'], { id: 'a1' })
    pushSharingChanged()
    expect(client.getQueryState(['local-agents'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['local-agent', 'a1'])?.isInvalidated).toBe(true)
  })
})
