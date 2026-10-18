import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The on-demand catalogue refresh: asked again when the engine's login or
 * binary changes (a failure is not sticky past a sign-in), retried on demand,
 * and never written into another profile's cache.
 */

const readiness = vi.hoisted(() => ({ auth: 'logged_out' as string, binary: 'ready' as string }))
vi.mock('./useLocalTools', () => ({
  useClaudeAuth: () => ({ data: { state: readiness.auth } }),
  useCodexAuth: () => ({ data: undefined }),
  useAntigravityAuth: () => ({ data: undefined })
}))
vi.mock('./useEngine', () => ({
  useClaudeBinary: () => ({ data: { state: readiness.binary } }),
  useCodexBinary: () => ({ data: undefined }),
  useAntigravityBinary: () => ({ data: undefined })
}))

const refreshModelCatalog = vi.fn()
;(window as unknown as { api: unknown }).api = { engine: { refreshModelCatalog, modelCatalog: vi.fn() } }

const { useRuntimeModelCatalogRefresh } = await import('./useRuntimeModelCatalog')
const { useAuthStore } = await import('../stores/auth.store')

const CATALOG = { engine: 'claude', models: [{ id: 'opus', name: 'Opus 5.5' }], source: 'session', updatedAt: 1 }
let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
  <QueryClientProvider client={client}>{children}</QueryClientProvider>

beforeEach(() => {
  client = new QueryClient()
  refreshModelCatalog.mockReset()
  readiness.auth = 'logged_out'
  readiness.binary = 'ready'
  useAuthStore.getState().setCurrentUser({ id: 'p1' } as never)
})

describe('useRuntimeModelCatalogRefresh', () => {
  it('asks again when the login changes, and on retry, but not on a remount', async () => {
    // Mutation: drop the readiness from the key and a failed refresh stands for ten minutes after the user signs in.
    refreshModelCatalog.mockResolvedValue({ catalog: CATALOG, error: 'Claude Code is not logged in.' })
    const first = renderHook(() => useRuntimeModelCatalogRefresh('claude', true), { wrapper })
    await waitFor(() => expect(refreshModelCatalog).toHaveBeenCalledTimes(1))
    first.unmount()
    const { rerender, result } = renderHook(() => useRuntimeModelCatalogRefresh('claude', true), { wrapper })
    await act(async () => {})
    expect(refreshModelCatalog).toHaveBeenCalledTimes(1)
    readiness.auth = 'logged_in'
    rerender()
    await waitFor(() => expect(refreshModelCatalog).toHaveBeenCalledTimes(2))
    act(() => result.current.retry())
    await waitFor(() => expect(refreshModelCatalog).toHaveBeenCalledTimes(3))
  })

  it('does not ask again for a readiness change that is not ready-or-not', async () => {
    // Mutation: key on the raw states and `resolving` → `ready` while still signed out is a second probe.
    refreshModelCatalog.mockResolvedValue({ catalog: CATALOG, error: 'Claude Code is not logged in.' })
    readiness.binary = 'resolving'
    const { rerender } = renderHook(() => useRuntimeModelCatalogRefresh('claude', true), { wrapper })
    await waitFor(() => expect(refreshModelCatalog).toHaveBeenCalledTimes(1))
    readiness.binary = 'ready'
    rerender()
    readiness.auth = 'unknown'
    rerender()
    await act(async () => {})
    expect(refreshModelCatalog).toHaveBeenCalledTimes(1)
    readiness.binary = 'ready'
  })

  it('writes the fresh catalogue into its own profile’s cache, and drops it after a profile switch', async () => {
    // Mutation: drop the profile check and the old profile's list lands in the new profile's cache.
    let release!: (value: unknown) => void
    refreshModelCatalog.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    // The new profile's own refresh, still running.
    refreshModelCatalog.mockReturnValueOnce(new Promise(() => undefined))
    renderHook(() => useRuntimeModelCatalogRefresh('claude', true), { wrapper })
    await waitFor(() => expect(refreshModelCatalog).toHaveBeenCalled())
    act(() => useAuthStore.getState().setCurrentUser({ id: 'p2' } as never))
    await act(async () => { release({ catalog: CATALOG, error: null }) })
    expect(client.getQueryData(['runtime-model-catalog', 'p1', 'claude'])).toBeUndefined()
    expect(client.getQueryData(['runtime-model-catalog', 'p2', 'claude'])).toBeUndefined()
  })

  it('writes an answer for the profile still active into that profile’s cache', async () => {
    refreshModelCatalog.mockResolvedValue({ catalog: CATALOG, error: null })
    renderHook(() => useRuntimeModelCatalogRefresh('claude', true), { wrapper })
    await waitFor(() => expect(client.getQueryData(['runtime-model-catalog', 'p1', 'claude'])).toEqual(CATALOG))
  })
})
