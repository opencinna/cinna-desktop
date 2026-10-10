import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogEntryView } from '../components/agents/CatalogItemViews'
import type { LibraryAgentDto } from '../../../shared/agentSharing'

/**
 * The catalog's actions as the dialog and Settings → Catalog both run them:
 * each one that ends on an agent lands the user there and tells the host to
 * close what covers it; each failure belongs to the item it came from.
 */

window.api = {} as never
const { useCatalogActions } = await import('./useCatalogActions')
const { useUIStore } = await import('../stores/ui.store')
const { useAuthStore } = await import('../stores/auth.store')
const { useCatalogInstallStore } = await import('../stores/catalogInstall.store')

const PAYROLL: LibraryAgentDto = {
  uuid: 'u-pay',
  bundleId: 'b',
  repoId: 'r-pay',
  slug: 'payroll',
  name: 'Payroll',
  description: '',
  cloneUrl: 'https://core.test/git/r.git',
  headSha: 'a',
  access: 'use',
  visibility: 'users',
  isListed: true,
  maintainers: [],
  engine: null,
  manifestId: null,
  latest: null,
  localAgentId: null,
  updateAvailable: false
}

const desktopView = { kind: 'desktop_agent', item: { id: 'b', uuid: 'u-pay' }, desktop: PAYROLL, cloud: null } as unknown as CatalogEntryView
const cloudView = {
  kind: 'cloud_agent',
  item: { id: 'acme/invoices', uuid: 'u-inv' },
  desktop: null,
  cloud: { installId: 'inst-1', agentId: 'remote:1', updateAvailable: true }
} as unknown as CatalogEntryView

let sharingGet: ReturnType<typeof vi.fn>
let uninstall: ReturnType<typeof vi.fn>
let applyBundleUpdate: ReturnType<typeof vi.fn>

beforeEach(() => {
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user' } as never })
  useCatalogInstallStore.setState({ installingBundleId: null, error: null, pendingSetup: null })
  useUIStore.setState({ activeView: 'settings', activeLocalAgentId: null, activeExternalAgentId: null })
  sharingGet = vi.fn()
  uninstall = vi.fn()
  applyBundleUpdate = vi.fn()
  window.api = {
    sharing: { get: sharingGet },
    catalog: { uninstall },
    agents: { applyBundleUpdate, syncRemote: vi.fn().mockResolvedValue({ success: true }) },
    logger: { log: vi.fn().mockResolvedValue(undefined) }
  } as never
})

function mountActions(onLanded: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useCatalogActions({ onLanded }), { wrapper })
}

const shareResult = (done: boolean, agentId: string | null) => ({
  success: true,
  value: { done, refusal: done ? null : 'no_access', detail: null, status: null, agentId, autoAttached: [], finishSetup: false }
})

describe('useCatalogActions', () => {
  it('a desktop Get lands on the local agent it made, after telling the host', async () => {
    sharingGet.mockResolvedValue(shareResult(true, 'folder:payroll'))
    const onLanded = vi.fn()
    const { result } = mountActions(onLanded)
    act(() => result.current.desktop.onGet('r-pay'))
    await waitFor(() => expect(useUIStore.getState().activeLocalAgentId).toBe('folder:payroll'))
    expect(useUIStore.getState().activeView).toBe('local-agent')
    expect(onLanded).toHaveBeenCalledTimes(1)
  })

  it('a refused desktop Get stays on that item, and clearErrors forgets it', async () => {
    sharingGet.mockResolvedValue(shareResult(false, null))
    const onLanded = vi.fn()
    const { result } = mountActions(onLanded)
    act(() => result.current.desktop.onGet('r-pay'))
    await waitFor(() => expect(result.current.errorFor(desktopView)).toBeTruthy())
    expect(result.current.errorFor(cloudView)).toBeNull()
    expect(onLanded).not.toHaveBeenCalled()
    act(() => result.current.clearErrors())
    expect(result.current.errorFor(desktopView)).toBeNull()
  })

  it('Open of a synced cloud agent lands on its page', () => {
    const onLanded = vi.fn()
    const { result } = mountActions(onLanded)
    act(() => result.current.install.onOpen('remote:1'))
    expect(onLanded).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().activeExternalAgentId).toBe('remote:1')
    expect(useUIStore.getState().activeView).toBe('external-agent')
  })

  it('a failed cloud update belongs to its install', async () => {
    applyBundleUpdate.mockResolvedValue({ success: false, error: 'Bundle is gone' })
    const { result } = mountActions(vi.fn())
    act(() => result.current.cloudUpdate.onUpdate('inst-1'))
    await waitFor(() => expect(result.current.errorFor(cloudView)).toBe('Bundle is gone'))
  })

  it('Uninstall reports its install while it runs, and its failure without the IPC prefix', async () => {
    let fail!: (err: Error) => void
    uninstall.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)))
    const { result } = mountActions(vi.fn())
    const onUninstalled = vi.fn()
    act(() => result.current.uninstall.onUninstall('inst-1', onUninstalled))
    await waitFor(() => expect(result.current.uninstall.uninstallingInstallId).toBe('inst-1'))
    await act(async () => fail(new Error("Error invoking remote method 'catalog:uninstall': CinnaApiError: Not allowed")))
    await waitFor(() => expect(result.current.uninstall.error).toEqual({ installId: 'inst-1', message: 'Not allowed' }))
    expect(onUninstalled).not.toHaveBeenCalled()
    act(() => result.current.uninstall.clearError())
    await waitFor(() => expect(result.current.uninstall.error).toBeNull())
  })
})
