import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogItem } from '../../../shared/catalogItems'
import type { LibraryAgentDto } from '../../../shared/agentSharing'
import type { CatalogEntryView } from '../components/agents/CatalogItemViews'

/**
 * The composer picker's Catalog section: the catalog's agents not on this
 * computer yet — a cloud agent without an install of the user's, a desktop
 * agent no local agent holds — and never a skill. A Get from it ends with the
 * new agent selected in the chat it was clicked in, and nothing selected once
 * the picker is gone.
 */

window.api = {} as never
const { catalogPickerItems, useCatalogPicker } = await import('./useCatalogPicker')
const { useCatalogInstallStore } = await import('../stores/catalogInstall.store')
const { useAuthStore } = await import('../stores/auth.store')
const { CATALOG_TEXT } = await import('../utils/catalogItems')

function item(overrides: Partial<CatalogItem>): CatalogItem {
  return {
    kind: 'agent',
    runs_on: 'cloud',
    uuid: 'uuid',
    id: 'test.core.item',
    name: 'Item',
    display_name: 'Item',
    description: null,
    publisher: null,
    maintainers: [],
    access: 'use',
    visibility: 'public',
    is_listed: true,
    latest: { revision_number: 1, version: null, published_at: '2026-10-01T00:00:00Z', published_by: null, release_notes: null },
    install_count: 0,
    my_installs: [],
    required_credential_specs: [],
    skills: [],
    desktop: null,
    skill: null,
    ...overrides
  }
}

function libraryAgent(overrides: Partial<LibraryAgentDto>): LibraryAgentDto {
  return {
    uuid: 'u',
    bundleId: 'b',
    repoId: 'r',
    slug: 'agent',
    name: 'Agent',
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
    updateAvailable: false,
    ...overrides
  }
}

function view(overrides: Partial<CatalogEntryView>): CatalogEntryView {
  return {
    item: item({ uuid: overrides.item?.uuid ?? 'uuid' }),
    kind: 'cloud_agent',
    name: 'Item',
    people: null,
    version: null,
    specs: [],
    cloud: null,
    desktop: null,
    usedBy: [],
    skillTargets: [],
    ...overrides
  }
}

describe('catalogPickerItems', () => {
  it('lists cloud agents without an install and desktop agents no local agent holds — no skills', () => {
    const items = catalogPickerItems([
      view({
        item: item({ uuid: 'cloud-new', description: 'Flags invoices' }),
        name: 'Invoices',
        people: 'Acme',
        version: 'Version 3',
        specs: [{ name: 'Xero', type: 'oauth', description: null, providedBy: 'user' }, { name: 'Slack', type: 'api_key', description: null, providedBy: 'user' }],
        cloud: { installId: null, agentId: null, updateAvailable: false }
      }),
      view({ item: item({ uuid: 'cloud-mine' }), cloud: { installId: 'inst-1', agentId: 'remote:1', updateAvailable: false } }),
      view({ item: item({ uuid: 'desk-new' }), kind: 'desktop_agent', name: 'Payroll', desktop: libraryAgent({ repoId: 'r-pay' }) }),
      view({ item: item({ uuid: 'desk-held' }), kind: 'desktop_agent', desktop: libraryAgent({ localAgentId: 'folder:ledger' }) }),
      // No team entry: nothing to Get it through.
      view({ item: item({ uuid: 'desk-unknown' }), kind: 'desktop_agent', desktop: null }),
      view({ item: item({ uuid: 'skill' }), kind: 'skill' })
    ])
    expect(items).toEqual([
      // A tile's lines: the version, and the credentials a Get will ask for (it skips the setup check).
      { id: 'cloud-new', kind: 'cloud_agent', name: 'Invoices', description: 'Flags invoices', meta: 'Acme', version: 'Version 3', needs: CATALOG_TEXT.needs('Xero, Slack') },
      { id: 'desk-new', kind: 'desktop_agent', name: 'Payroll', description: null, meta: null, version: null, needs: null }
    ])
  })
})

const CLOUD = item({ uuid: 'u-inv', id: 'acme/invoices', name: 'Invoices', display_name: 'Invoices' })
const DESKTOP = item({ uuid: 'u-pay', runs_on: 'desktop', name: 'Payroll', display_name: 'Payroll' })
const PAYROLL_LIB = libraryAgent({ uuid: 'u-pay', repoId: 'r-pay', name: 'Payroll' })

let quickInstall: ReturnType<typeof vi.fn>
let sharingGet: ReturnType<typeof vi.fn>

beforeEach(() => {
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user' } as never })
  useCatalogInstallStore.setState({ installingBundleId: null, error: null, pendingSetup: null })
  quickInstall = vi.fn()
  sharingGet = vi.fn()
  window.api = {
    catalog: {
      items: vi.fn().mockResolvedValue({
        success: true,
        value: { host: 'https://core.test', items: [CLOUD, DESKTOP], fetchedAt: '2026-10-10T00:00:00Z', available: true }
      }),
      quickInstall,
      setupStatus: vi.fn().mockResolvedValue({ status: 'ready', missing: [], setupUrl: null })
    },
    sharing: {
      library: vi.fn().mockResolvedValue({
        success: true,
        value: { host: 'https://core.test', agents: [PAYROLL_LIB], fetchedAt: '2026-10-10T00:00:00Z' }
      }),
      statuses: vi.fn().mockResolvedValue({ success: true, value: [] }),
      get: sharingGet
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      syncRemote: vi.fn().mockResolvedValue({ success: true }),
      onRemoteSyncComplete: () => () => {},
      onReadinessChanged: () => () => {}
    },
    localAgents: { list: vi.fn().mockResolvedValue({ roots: [], agents: [] }) },
    logger: { log: vi.fn().mockResolvedValue(undefined) }
  } as never
})

function mountPicker(onInstalled: (agentId: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useCatalogPicker(onInstalled), { wrapper })
}

const getResult = (agentId: string | null, done = true) => ({
  success: true,
  value: { done, refusal: done ? null : 'push_rejected', detail: done ? null : 'no access', status: null, agentId, autoAttached: [], finishSetup: false }
})

describe('useCatalogPicker', () => {
  it('lists the not-yet-held agents of both kinds from the cached listing', async () => {
    const { result } = mountPicker(vi.fn())
    await waitFor(() => expect(result.current.catalogItems.map((entry) => entry.id)).toEqual(['u-inv', 'u-pay']))
    expect(result.current.catalogItems.map((entry) => entry.kind)).toEqual(['cloud_agent', 'desktop_agent'])
    // The picker reads what is cached; only a surface the user opened lists again.
    expect(window.api.catalog.items).toHaveBeenCalledWith(false)
  })

  it('a desktop Get selects the local agent it made', async () => {
    let land!: (value: unknown) => void
    sharingGet.mockReturnValue(new Promise((resolve) => (land = resolve)))
    const onInstalled = vi.fn()
    const { result } = mountPicker(onInstalled)
    await waitFor(() => expect(result.current.catalogItems).toHaveLength(2))
    act(() => result.current.install('u-pay'))
    await waitFor(() => expect(sharingGet).toHaveBeenCalledWith('r-pay'))
    await waitFor(() => expect(result.current.installingId).toBe('u-pay'))
    expect(result.current.busy).toBe(true)
    await act(async () => land(getResult('folder:payroll')))
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('folder:payroll'))
    expect(result.current.busy).toBe(false)
  })

  it('a desktop Get that lands after the picker closed selects nothing', async () => {
    let land!: (value: unknown) => void
    sharingGet.mockReturnValue(new Promise((resolve) => (land = resolve)))
    const onInstalled = vi.fn()
    const { result, unmount } = mountPicker(onInstalled)
    await waitFor(() => expect(result.current.catalogItems).toHaveLength(2))
    act(() => result.current.install('u-pay'))
    await waitFor(() => expect(sharingGet).toHaveBeenCalledWith('r-pay'))
    unmount()
    await act(async () => land(getResult('folder:payroll')))
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('a refused desktop Get says why, on this picker', async () => {
    sharingGet.mockResolvedValue(getResult(null, false))
    const onInstalled = vi.fn()
    const { result } = mountPicker(onInstalled)
    await waitFor(() => expect(result.current.catalogItems).toHaveLength(2))
    act(() => result.current.install('u-pay'))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('a cloud Get runs the quick install by catalog id, and shows only the error of the install it started', async () => {
    const { result } = mountPicker(vi.fn())
    await waitFor(() => expect(result.current.catalogItems).toHaveLength(2))
    // A failure the sidebar catalog left behind.
    act(() => useCatalogInstallStore.setState({ error: { bundleId: 'other/bundle', message: 'sidebar failure' } }))
    expect(result.current.error).toBeNull()
    quickInstall.mockResolvedValue({ success: false, code: 'forbidden', message: 'server said no' })
    act(() => result.current.install('u-inv'))
    expect(quickInstall).toHaveBeenCalledWith('acme/invoices')
    await waitFor(() => expect(result.current.error).toBe('server said no'))
    await waitFor(() => expect(useCatalogInstallStore.getState().installingBundleId).toBeNull())
  })

  it('after a cloud Get, stops offering the agent: main has listed again before the install answers', async () => {
    const onInstalled = vi.fn()
    const { result } = mountPicker(onInstalled)
    await waitFor(() => expect(result.current.catalogItems).toHaveLength(2))
    quickInstall.mockResolvedValue({ success: true, value: { installId: 'inst-1', bundleId: 'acme/invoices', agentName: 'Invoices' } })
    // Main's cached listing now names the install; the sync brings its row.
    ;(window.api.catalog.items as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      value: {
        host: 'https://core.test',
        items: [{ ...CLOUD, my_installs: [{ where: 'cloud', install_id: 'inst-1', revision_number: 1 }] }, DESKTOP],
        fetchedAt: '2026-10-10T00:01:00Z',
        available: true
      }
    })
    ;(window.api.agents.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'remote:1', remoteTargetId: 'inst-1' }])
    act(() => result.current.install('u-inv'))
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('remote:1'))
    await waitFor(() => expect(result.current.catalogItems.map((entry) => entry.id)).toEqual(['u-pay']))
  })
})
