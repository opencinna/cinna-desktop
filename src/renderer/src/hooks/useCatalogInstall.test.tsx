import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The catalog install sequence: install, await the remote sync, read the
 * agents back, and hand the synced agent to the owner. An install whose agent
 * never appears is an error on that bundle, not silence. The install lives in
 * a store, so it outlives the component that started it, and only one runs at
 * a time across every surface.
 */

window.api = {} as never
const { useCatalogInstall } = await import('./useCatalogInstall')
const { useCatalogInstallStore, landCatalogInstall } = await import('../stores/catalogInstall.store')
const { useAuthStore } = await import('../stores/auth.store')
const { useUIStore } = await import('../stores/ui.store')

const RESULT = { installId: 'install-1', bundleId: 'acme/invoices', agentName: 'Invoice Watcher' }
let quickInstall: ReturnType<typeof vi.fn>
let syncRemote: ReturnType<typeof vi.fn>
let list: ReturnType<typeof vi.fn>
let setupStatus: ReturnType<typeof vi.fn>

/** A successful `catalog:quick-install` outcome. */
const ok = <T,>(value: T): { success: true; value: T } => ({ success: true, value })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const setProfile = (id: string | null): void =>
  useAuthStore.setState({ currentUser: id ? ({ id, type: 'cinna_user' } as never) : null })

beforeEach(() => {
  quickInstall = vi.fn().mockResolvedValue(ok(RESULT))
  syncRemote = vi.fn().mockResolvedValue({ success: true, synced: 1 })
  list = vi.fn().mockResolvedValue([{ id: 'remote:1', remoteTargetId: 'install-1' }])
  setupStatus = vi.fn().mockResolvedValue({ status: 'ready', missing: [], setupUrl: null })
  window.api = {
    catalog: { quickInstall, setupStatus },
    agents: { syncRemote, list },
    logger: { log: vi.fn().mockResolvedValue(undefined) }
  } as never
  useCatalogInstallStore.setState({ installingBundleId: null, error: null, pendingSetup: null })
  useUIStore.setState({ activeView: 'chat', activeExternalAgentId: null, agentPageMode: 'settings' })
  setProfile('p1')
})

function mount(
  callbacks: Parameters<typeof useCatalogInstall>[0],
  client: QueryClient = new QueryClient()
): ReturnType<typeof renderHook<ReturnType<typeof useCatalogInstall>, unknown>> {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useCatalogInstall(callbacks), { wrapper })
}

const idle = (): Promise<void> =>
  waitFor(() => expect(useCatalogInstallStore.getState().installingBundleId).toBeNull())

describe('useCatalogInstall', () => {
  it('syncs before reading the agents back, then hands over the synced agent', async () => {
    const onInstalled = vi.fn()
    const { result } = mount({ onInstalled })
    act(() => result.current.install('acme/invoices'))
    expect(result.current.installingBundleId).toBe('acme/invoices')
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('remote:1', RESULT))
    expect(syncRemote.mock.invocationCallOrder[0]).toBeLessThan(list.mock.invocationCallOrder[0])
    await waitFor(() => expect(result.current.installingBundleId).toBeNull())
    expect(result.current.error).toBeNull()
  })

  it('reports an install whose agent has not appeared, on that bundle', async () => {
    list.mockResolvedValue([])
    const onInstalled = vi.fn()
    const { result } = mount({ onInstalled })
    act(() => result.current.install('acme/invoices'))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toEqual({
      bundleId: 'acme/invoices',
      message: 'Installed — it will appear in your agents after the next sync.'
    })
    expect(onInstalled).not.toHaveBeenCalled()
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
    await idle()
  })

  it('reports a failed sync as data — an expired session in its own words', async () => {
    syncRemote.mockResolvedValue({ success: false, code: 'reauth_required', error: 'expired' })
    const onInstalled = vi.fn()
    const { result } = mount({ onInstalled })
    act(() => result.current.install('acme/invoices'))
    await waitFor(() =>
      expect(result.current.error).toEqual({
        bundleId: 'acme/invoices',
        message:
          'Installed, but your Cinna session expired before it could be added — re-authenticate and it will appear.'
      })
    )
    expect(list).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
    await idle()
  })

  it('reports any other failed sync with its unwrapped reason', async () => {
    syncRemote.mockResolvedValue({
      success: false,
      error: "Error invoking remote method 'agent:sync-remote': CinnaApiError: Server unavailable"
    })
    const { result } = mount({ onInstalled: vi.fn() })
    act(() => result.current.install('acme/invoices'))
    await waitFor(() =>
      expect(result.current.error?.message).toBe(
        'Installed, but it could not be added to your agents yet: Server unavailable'
      )
    )
    await idle()
  })

  it('tells an expired session apart, from the code returned as data', async () => {
    // What main really sends: a thrown code would be stripped in transit.
    quickInstall.mockResolvedValue({
      success: false,
      code: 'reauth_required',
      message: 'Cinna re-authentication required'
    })
    const { result } = mount({})
    act(() => result.current.install('acme/invoices'))
    await waitFor(() =>
      expect(result.current.error).toEqual({
        bundleId: 'acme/invoices',
        message: 'Cinna session expired — re-authenticate in Settings to install.'
      })
    )
  })

  it('shows a coded server refusal in its own words', async () => {
    quickInstall.mockResolvedValue({ success: false, code: 'forbidden', message: 'Quota reached' })
    const { result } = mount({})
    act(() => result.current.install('acme/invoices'))
    await waitFor(() =>
      expect(result.current.error).toEqual({ bundleId: 'acme/invoices', message: 'Quota reached' })
    )
  })

  it('unwraps an IPC failure into the bundle’s error', async () => {
    quickInstall.mockRejectedValue(
      new Error("Error invoking remote method 'catalog:quick-install': CinnaApiError: Quota reached")
    )
    const { result } = mount({})
    act(() => result.current.install('acme/invoices'))
    await waitFor(() =>
      expect(result.current.error).toEqual({ bundleId: 'acme/invoices', message: 'Quota reached' })
    )
    await waitFor(() => expect(result.current.installingBundleId).toBeNull())
  })

  it('ignores a second install while one is running', async () => {
    const { result } = mount({})
    act(() => {
      result.current.install('acme/invoices')
      result.current.install('fx/rates')
    })
    await idle()
    expect(quickInstall).toHaveBeenCalledTimes(1)
  })

  it('runs one install across callers: a second surface sees it and cannot start another', async () => {
    const pending = deferred<typeof RESULT>()
    quickInstall.mockReturnValueOnce(pending.promise.then(ok))
    const client = new QueryClient()
    const sidebar = mount({ onInstalled: vi.fn() }, client)
    const picker = mount({ onInstalled: vi.fn() }, client)
    act(() => sidebar.result.current.install('acme/invoices'))
    expect(picker.result.current.installingBundleId).toBe('acme/invoices')
    act(() => picker.result.current.install('fx/rates'))
    // A remounted owner is a fresh hook instance, and still cannot.
    sidebar.unmount()
    const remounted = mount({ onInstalled: vi.fn() }, client)
    act(() => remounted.result.current.install('acme/invoices'))
    expect(quickInstall).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(RESULT))
    await idle()
    // Once it has finished, the next one may run.
    act(() => picker.result.current.install('fx/rates'))
    await idle()
    expect(quickInstall).toHaveBeenCalledTimes(2)
  })

  it('finishes after its owner unmounts: the detached landing runs, the bound one does not', async () => {
    const pending = deferred<typeof RESULT>()
    quickInstall.mockReturnValueOnce(pending.promise.then(ok))
    setupStatus.mockResolvedValue({ status: 'needs_setup', missing: [], setupUrl: null })
    const client = new QueryClient()
    const onInstalled = vi.fn()
    const view = mount(
      {
        onInstalled,
        onInstalledDetached: (agentId, result) => landCatalogInstall(client, agentId, result)
      },
      client
    )
    act(() => view.result.current.install('acme/invoices'))
    view.unmount()
    await act(async () => pending.resolve(RESULT))

    await waitFor(() =>
      expect(useCatalogInstallStore.getState().pendingSetup).toEqual({
        installId: 'install-1',
        agentName: 'Invoice Watcher',
        profileId: 'p1'
      })
    )
    const ui = useUIStore.getState()
    expect(ui.activeExternalAgentId).toBe('remote:1')
    expect(ui.activeView).toBe('external-agent')
    expect(ui.agentPageMode).toBe('chat')
    expect(onInstalled).not.toHaveBeenCalled()
    await idle()
  })

  it('drops the result of an install that finishes under another profile', async () => {
    const pending = deferred<typeof RESULT>()
    quickInstall.mockReturnValueOnce(pending.promise.then(ok))
    const client = new QueryClient()
    const onInstalled = vi.fn()
    const detached = vi.fn()
    const { result } = mount({ onInstalled, onInstalledDetached: detached }, client)
    act(() => result.current.install('acme/invoices'))
    setProfile('p2')
    await act(async () => pending.resolve(RESULT))
    await idle()
    expect(onInstalled).not.toHaveBeenCalled()
    expect(detached).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
    expect(useUIStore.getState().activeView).toBe('chat')
  })

  it('drops an install failure that lands under another profile', async () => {
    const pending = deferred<typeof RESULT>()
    quickInstall.mockReturnValueOnce(pending.promise.then(() => Promise.reject(new Error('boom'))))
    const { result } = mount({})
    act(() => result.current.install('acme/invoices'))
    setProfile('p2')
    await act(async () => pending.resolve(RESULT))
    await idle()
    expect(result.current.error).toBeNull()
  })
})

describe('completion callbacks', () => {
  it('calls the callback from the click, not one rendered later', async () => {
    // ChatInput switches chats without remounting; an install started in chat
    // A must not attach its agent to chat B.
    const sync = deferred<{ success: true; synced: number }>()
    syncRemote.mockReturnValue(sync.promise)
    const chatA = vi.fn()
    const chatB = vi.fn()
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
      createElement(QueryClientProvider, { client }, children)
    const { result, rerender } = renderHook(
      ({ cb }) => useCatalogInstall({ onInstalled: cb }),
      { wrapper, initialProps: { cb: chatA } }
    )
    act(() => result.current.install('acme/invoices'))
    rerender({ cb: chatB })
    await act(async () => sync.resolve({ success: true, synced: 1 }))
    await waitFor(() => expect(chatA).toHaveBeenCalledWith('remote:1', RESULT))
    expect(chatB).not.toHaveBeenCalled()
    await idle()
  })
})

describe('useCatalogPicker', () => {
  it('shows only the error of the install it started', async () => {
    const { useCatalogPicker } = await import('./useCatalogPicker')
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
      createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useCatalogPicker(vi.fn()), { wrapper })
    // A failure the sidebar catalog left behind.
    act(() =>
      useCatalogInstallStore.setState({ error: { bundleId: 'other/bundle', message: 'sidebar failure' } })
    )
    expect(result.current.error).toBeNull()
    quickInstall.mockResolvedValue({ success: false, code: 'forbidden', message: 'server said no' })
    act(() => result.current.install('acme/invoices'))
    await waitFor(() => expect(result.current.error).toBe('server said no'))
    await idle()
  })
})

describe('landCatalogInstall', () => {
  it('opens the agent and raises no setup when its credentials are ready', async () => {
    const client = new QueryClient()
    landCatalogInstall(client, 'remote:1', RESULT)
    expect(useUIStore.getState().activeExternalAgentId).toBe('remote:1')
    await waitFor(() => expect(setupStatus).toHaveBeenCalledWith('install-1'))
    await act(async () => {})
    expect(useCatalogInstallStore.getState().pendingSetup).toBeNull()
  })

  it('treats a failed status check as needing setup', async () => {
    setupStatus.mockRejectedValue(new Error('offline'))
    landCatalogInstall(new QueryClient(), 'remote:1', RESULT)
    await waitFor(() =>
      expect(useCatalogInstallStore.getState().pendingSetup?.installId).toBe('install-1')
    )
  })

  it('raises no setup if the profile changed while the status was checked', async () => {
    const pending = deferred<{ status: string; missing: never[]; setupUrl: null }>()
    setupStatus.mockReturnValue(pending.promise)
    landCatalogInstall(new QueryClient(), 'remote:1', RESULT)
    setProfile('p2')
    await act(async () => pending.resolve({ status: 'needs_setup', missing: [], setupUrl: null }))
    expect(useCatalogInstallStore.getState().pendingSetup).toBeNull()
  })
})
