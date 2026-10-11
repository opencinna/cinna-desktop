import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentShareStatus } from '../../../shared/agentSharing'

/**
 * A push from main that lands while a query's *first* read is still out must
 * not be lost. TanStack joins an invalidation onto that read instead of
 * restarting it, so at launch the statuses read begun before the first
 * catalog listing landed kept `access: null` after the listing's
 * `sharing:changed` — and the maintainer's Skills rows offered no Update or
 * Remove until something else re-read it.
 */

const { useAuthStore } = await import('../stores/auth.store')
const { useListedShareStatus, useSharingWatch } = await import('./useSharing')
const { useCatalogItemsWatch } = await import('./useCatalog')
const { useLocalAgent } = await import('./useLocalAgents')

const ok = <T,>(value: T) => ({ success: true as const, value })

function status(access: AgentShareStatus['remote']['access']): AgentShareStatus {
  return {
    agentId: 'a1',
    remote: { kind: 'cinna', url: 'https://core.test/git/r1.git', repoId: 'r1', host: 'https://core.test', access }
  } as unknown as AgentShareStatus
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

let statuses: ReturnType<typeof vi.fn>
let get: ReturnType<typeof vi.fn>
let pushSharingChanged: () => void
let pushItemsChanged: () => void

beforeEach(() => {
  useAuthStore.setState({
    currentUser: { id: 'p1', type: 'cinna_user', username: 'u', displayName: 'U', hasPassword: false } as never
  })
  statuses = vi.fn()
  get = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    catalog: {
      items: vi.fn(),
      onItemsChanged: vi.fn((handler: () => void) => {
        pushItemsChanged = handler
        return () => {}
      })
    },
    sharing: {
      statuses,
      onChanged: vi.fn((handler: () => void) => {
        pushSharingChanged = handler
        return () => {}
      })
    },
    localAgents: { get, onChanged: vi.fn(() => () => {}) }
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('a push while the first read is out', () => {
  it('sharing:changed reads the statuses again once the stale first answer lands', async () => {
    const first = deferred<ReturnType<typeof ok<AgentShareStatus[]>>>()
    statuses.mockReturnValueOnce(first.promise).mockResolvedValue(ok([status('maintain')]))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seen: { access?: string | null } = {}
    function Page(): null {
      useSharingWatch()
      seen.access = useListedShareStatus('a1')?.remote.access
      return null
    }
    render(createElement(QueryClientProvider, { client }, createElement(Page)))
    await waitFor(() => expect(statuses).toHaveBeenCalledTimes(1))

    // The listing lands while main's first answer (computed without it) is on its way.
    act(() => pushSharingChanged())
    await act(async () => first.resolve(ok([status(null)])))

    await waitFor(() => expect(seen.access).toBe('maintain'))
    expect(statuses).toHaveBeenCalledTimes(2)
  })

  it('catalog:items-changed reads an open agent page again once its first answer lands', async () => {
    const first = deferred<unknown>()
    get.mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true, value: { id: 'a1', skills: [{ name: 's', updatable: true }] } })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seen: { updatable?: boolean } = {}
    function Page(): null {
      useCatalogItemsWatch()
      const agent = useLocalAgent('a1').data as { skills?: { updatable?: boolean }[] } | undefined
      seen.updatable = agent?.skills?.[0]?.updatable
      return null
    }
    render(createElement(QueryClientProvider, { client }, createElement(Page)))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))

    act(() => pushItemsChanged())
    await act(async () => first.resolve({ ok: true, value: { id: 'a1', skills: [{ name: 's', updatable: false }] } }))

    await waitFor(() => expect(seen.updatable).toBe(true))
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('a read already settled is re-read once, as a plain invalidation does', async () => {
    statuses.mockResolvedValue(ok([status('maintain')]))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Page(): null {
      useSharingWatch()
      useListedShareStatus('a1')
      return null
    }
    render(createElement(QueryClientProvider, { client }, createElement(Page)))
    await waitFor(() => expect(client.getQueryState(['sharing', 'statuses', 'p1'])?.status).toBe('success'))
    act(() => pushSharingChanged())
    await waitFor(() => expect(statuses).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(statuses).toHaveBeenCalledTimes(2)
  })
})
