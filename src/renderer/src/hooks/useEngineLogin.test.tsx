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
;(window as unknown as { api: unknown }).api = {
  localTools: api,
  settings: { getAll: vi.fn(async () => ({ localAgentsClaudePath: '' })) }
}

const { useEngineLogin } = await import('./useLocalTools')
const { useClaudeBinary } = await import('./useEngine')

/** Past TanStack's batched notify (a `setTimeout(0)`), so a render that is coming has come. */
const settle = (): Promise<void> => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 20) }))

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
  return { ...renderHook(() => useEngineLogin(engine), { wrapper }), invalidated, client }
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

  it('forgets a failure once the Path setting changes', async () => {
    const { result, client } = mount('claude')
    await waitFor(() => expect(client.getQueryData(['app-settings'])).toBeDefined())
    act(() => result.current.start())
    await waitFor(() => expect(result.current.pending).toBe(true))
    await act(async () => { finish({ outcome: 'failed', command: null, reason: 'Claude Code could not be installed.' }) })
    await waitFor(() => expect(result.current.failure?.outcome).toBe('failed'))
    act(() => { client.setQueryData(['app-settings'], { localAgentsClaudePath: '/opt/claude' }) })
    await waitFor(() => expect(result.current.failure).toBeNull())
  })

  it('forgets a failure once the binary is ready at a new path', async () => {
    const { result, client } = mount('claude')
    act(() => { client.setQueryData(['claude-binary'], { state: 'failed', error: 'offline' }) })
    act(() => result.current.start())
    await waitFor(() => expect(result.current.pending).toBe(true))
    await act(async () => { finish({ outcome: 'failed', command: null, reason: 'Claude Code could not be installed.' }) })
    await waitFor(() => expect(result.current.failure?.outcome).toBe('failed'))
    // A re-read that says the same thing keeps the line.
    act(() => { client.setQueryData(['claude-binary'], { state: 'failed', error: 'still offline' }) })
    expect(result.current.failure?.outcome).toBe('failed')
    act(() => { client.setQueryData(['claude-binary'], { state: 'ready', path: '/opt/claude', source: 'managed', version: '2.1' }) })
    await waitFor(() => expect(result.current.failure).toBeNull())
  })

  it('keeps the outcome of a login whose binary changed while it ran', async () => {
    const { result, client } = mount('claude')
    api.engineLogin.mockClear()
    act(() => result.current.start())
    await waitFor(() => expect(api.engineLogin).toHaveBeenCalled())
    act(() => { client.setQueryData(['claude-binary'], { state: 'ready', path: '/managed/claude', source: 'managed', version: '2.1' }) })
    await act(async () => { finish({ outcome: 'timeout', command: "'/managed/claude' auth login" }) })
    await waitFor(() => expect(result.current.failure?.outcome).toBe('timeout'))
  })

  it('keeps a failure through a re-check that lands on the same binary, and does not bring one back', async () => {
    const ready = (path: string): unknown => ({ state: 'ready', path, source: 'managed', version: '2.1' })
    const { result, client } = mount('claude')
    await waitFor(() => expect(client.getQueryData(['app-settings'])).toBeDefined())
    act(() => { client.setQueryData(['claude-binary'], ready('/p')) })
    api.engineLogin.mockClear()
    act(() => result.current.start())
    await waitFor(() => expect(api.engineLogin).toHaveBeenCalled())
    await act(async () => { finish({ outcome: 'timeout', command: "'/p' auth login" }) })
    await waitFor(() => expect(result.current.failure?.outcome).toBe('timeout'))
    // Check again: resolving, then the same path. Nothing was fixed.
    act(() => { client.setQueryData(['claude-binary'], { state: 'resolving' }) })
    act(() => { client.setQueryData(['claude-binary'], ready('/p')) })
    await settle()
    expect(result.current.failure?.outcome).toBe('timeout')
    // A Path set and then cleared again: hidden at the first, and stays so.
    act(() => { client.setQueryData(['app-settings'], { localAgentsClaudePath: '/opt/claude' }) })
    await waitFor(() => expect(result.current.failure).toBeNull())
    act(() => { client.setQueryData(['app-settings'], { localAgentsClaudePath: '' }) })
    await settle()
    expect(result.current.failure).toBeNull()
  })

  it('takes a binary unknown when the login ended as no evidence', async () => {
    const { result, client } = mount('claude')
    api.engineLogin.mockClear()
    act(() => result.current.start())
    await waitFor(() => expect(api.engineLogin).toHaveBeenCalled())
    await act(async () => { finish({ outcome: 'timeout', command: null }) })
    await waitFor(() => expect(result.current.failure?.outcome).toBe('timeout'))
    act(() => { client.setQueryData(['claude-binary'], { state: 'ready', path: '/p', source: 'managed', version: '2.1' }) })
    await settle()
    expect(result.current.failure?.outcome).toBe('timeout')
  })

  it('leaves the binary query a real fetcher, so a global refetch still works', async () => {
    // Mutation: observe with `queryFn: skipToken` and the hook's options,
    // written onto the shared query after the Settings row's, make every
    // refetch of it fail with "Missing queryFn".
    ;(window as unknown as { api: { engine?: unknown } }).api.engine = { claudeBinary: vi.fn(async () => ({ state: 'unresolved' })) }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
      createElement(QueryClientProvider, { client }, children)
    renderHook(() => { useClaudeBinary(); return useEngineLogin('claude') }, { wrapper })
    await waitFor(() => expect(client.getQueryState(['claude-binary'])?.status).toBe('success'))
    await act(async () => { await client.invalidateQueries() })
    expect(client.getQueryState(['claude-binary'])?.status).toBe('success')
  })
})
