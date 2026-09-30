import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

/**
 * The in-app login's re-reads live in the `useMutation` options, so they run
 * when the login ends even if the surface that started it has unmounted — a
 * browser sign-in takes minutes, and a mutate-level callback would be dropped.
 */

let finish!: (value: unknown) => void
const api = {
  engineLogin: vi.fn(() => new Promise((resolve) => { finish = resolve })),
  engineLoginCancel: vi.fn(async () => true),
  engineLoginRunning: vi.fn(async (): Promise<Record<'claude' | 'codex', 'preparing' | 'waiting' | null>> => ({ claude: null, codex: null }))
}
;(window as unknown as { api: unknown }).api = { localTools: api }

const { useEngineLogin } = await import('./useLocalTools')

function mount(engine: 'claude' | 'codex' | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidated: unknown[] = []
  const original = client.invalidateQueries.bind(client)
  client.invalidateQueries = ((filters?: Parameters<typeof original>[0]) => {
    invalidated.push(filters?.queryKey)
    return original(filters)
  }) as typeof client.invalidateQueries
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  return { ...renderHook(() => useEngineLogin(engine), { wrapper }), invalidated }
}

describe('useEngineLogin', () => {
  it('re-reads the login, the running flag and the agents after the starter unmounted', async () => {
    const { result, unmount, invalidated } = mount('codex')
    act(() => result.current.start())
    await waitFor(() => expect(api.engineLogin).toHaveBeenCalledWith('codex'))
    unmount()
    invalidated.length = 0
    await act(async () => { finish({ outcome: 'logged_in', command: "'/opt/codex' login" }) })
    await waitFor(() => expect(invalidated).toContainEqual(['codex-auth']))
    expect(invalidated).toContainEqual(['engine-login-running'])
    expect(invalidated).toContainEqual(['agents'])
  })

  it('keeps the last outcome that was not a login, and forgets it on reset', async () => {
    const { result } = mount('claude')
    act(() => result.current.start())
    await waitFor(() => expect(result.current.pending).toBe(true))
    await act(async () => { finish({ outcome: 'timeout', command: "'/opt/claude' auth login" }) })
    await waitFor(() => expect(result.current.failure?.outcome).toBe('timeout'))
    expect(result.current.pending).toBe(false)
    act(() => result.current.reset())
    await waitFor(() => expect(result.current.failure).toBeNull())
  })

  it('asks main for the login before it re-reads the running flag, so other surfaces see it', async () => {
    const { result } = mount('claude')
    await waitFor(() => expect(api.engineLoginRunning).toHaveBeenCalled())
    api.engineLogin.mockClear()
    api.engineLoginRunning.mockClear()
    api.engineLoginRunning.mockResolvedValue({ claude: 'preparing', codex: null })
    act(() => result.current.start())
    await waitFor(() => expect(api.engineLoginRunning).toHaveBeenCalled())
    expect(api.engineLogin).toHaveBeenCalledTimes(1)
    // IPC invokes are queued in call order: main registers the login before it
    // answers the re-read.
    expect(api.engineLogin.mock.invocationCallOrder[0]).toBeLessThan(api.engineLoginRunning.mock.invocationCallOrder[0])
    await waitFor(() => expect(result.current.phase).toBe('preparing'))
    api.engineLoginRunning.mockResolvedValue({ claude: null, codex: null })
    await act(async () => { finish({ outcome: 'cancelled', command: null }) })
    await waitFor(() => expect(result.current.pending).toBe(false))
  })

  it('shows another surface’s login, in its phase', async () => {
    api.engineLoginRunning.mockResolvedValue({ claude: null, codex: 'waiting' })
    const { result } = mount('codex')
    await waitFor(() => expect(result.current.phase).toBe('waiting'))
    expect(result.current.pending).toBe(true)
    api.engineLoginRunning.mockResolvedValue({ claude: null, codex: null })
  })

  it('asks main nothing without an engine', () => {
    api.engineLogin.mockClear()
    api.engineLoginRunning.mockClear()
    const { result } = mount(null)
    act(() => result.current.start())
    expect(api.engineLogin).not.toHaveBeenCalled()
    expect(api.engineLoginRunning).not.toHaveBeenCalled()
  })
})
