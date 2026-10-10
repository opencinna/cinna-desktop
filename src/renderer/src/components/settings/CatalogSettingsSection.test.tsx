import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogItem } from '../../../../shared/catalogItems'
import type { LibraryAgentDto } from '../../../../shared/agentSharing'

/**
 * Settings → Profile → Catalog is the catalog dialog's list on a settings
 * page: every kind, the same tiles and actions, from the same cached listing.
 * What has to hold is that it reads that listing (not a second one), that a
 * tile's action runs the shared action, and that an installed cloud agent can
 * still be uninstalled from here.
 */

vi.mock('./CatalogCardCredentials', () => ({ CatalogCardCredentials: () => null }))

window.api = {} as never
const { CatalogSettingsSection } = await import('./CatalogSettingsSection')
const { useAuthStore } = await import('../../stores/auth.store')
const { CATALOG_KIND_TEXT, CATALOG_TEXT } = await import('../../utils/catalogItems')

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

const INVOICES = item({ uuid: 'u-inv', id: 'test.core.inv', display_name: 'Invoice Watcher' })
const HELPDESK = item({
  uuid: 'u-help',
  id: 'test.core.help',
  display_name: 'Helpdesk',
  my_installs: [{ where: 'cloud', install_id: 'install-1', device_id: null, host_manifest_id: null, revision_number: 1 }]
})
const PAYROLL = item({ uuid: 'u-pay', runs_on: 'desktop', id: 'test.core.pay', display_name: 'Payroll Checker' })
const ERP = item({ uuid: 'u-erp', kind: 'skill', runs_on: null, id: 'test.core.skill.erp', display_name: 'erp-lookup' })

const PAYROLL_LIB: LibraryAgentDto = {
  uuid: 'u-pay',
  bundleId: 'test.core.pay',
  repoId: 'r-pay',
  slug: 'payroll',
  name: 'Payroll Checker',
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

let itemsMock: ReturnType<typeof vi.fn>
let sharingGet: ReturnType<typeof vi.fn>
let uninstall: ReturnType<typeof vi.fn>

beforeEach(() => {
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user' } as never })
  itemsMock = vi.fn().mockResolvedValue({
    success: true,
    value: { host: 'https://core.test', items: [INVOICES, HELPDESK, PAYROLL, ERP], fetchedAt: '2026-10-10T00:00:00Z', available: true }
  })
  sharingGet = vi.fn().mockReturnValue(new Promise(() => {}))
  uninstall = vi.fn().mockResolvedValue({ success: true })
  window.api = {
    catalog: {
      items: itemsMock,
      item: vi.fn().mockResolvedValue({ success: true, value: { ...HELPDESK, revisions: [] } }),
      serverUrl: vi.fn().mockResolvedValue('https://core.test'),
      uninstall
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
      list: vi.fn().mockResolvedValue([{ id: 'remote:help', name: 'Helpdesk', source: 'remote', remoteTargetId: 'install-1' }]),
      syncRemote: vi.fn().mockResolvedValue({ success: true }),
      onRemoteSyncComplete: () => () => {},
      onReadinessChanged: () => () => {}
    },
    localAgents: { list: vi.fn().mockResolvedValue({ roots: [], agents: [] }) },
    system: { openExternal: vi.fn() },
    logger: { log: vi.fn().mockResolvedValue(undefined) }
  } as never
})

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client }, createElement(CatalogSettingsSection)))
}

const tile = (name: string): HTMLElement => screen.getByRole('group', { name })

describe('CatalogSettingsSection', () => {
  it('says the catalog needs a Cinna account when signed out, and reads nothing', () => {
    useAuthStore.setState({ currentUser: null })
    mount()
    expect(screen.getByText(CATALOG_TEXT.signedOut)).toBeTruthy()
    expect(itemsMock).not.toHaveBeenCalled()
  })

  it('lists every kind from the catalog listing, read fresh when the tab opens', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Invoice Watcher',
      'Helpdesk',
      'Payroll Checker',
      'erp-lookup'
    ]))
    expect(itemsMock).toHaveBeenCalledWith(true)
    expect(screen.getByRole('heading', { name: CATALOG_TEXT.sectionTitle })).toBeTruthy()
    expect(screen.getByRole('button', { name: CATALOG_TEXT.refresh })).toBeTruthy()
    expect(within(tile('Payroll Checker')).getByText(CATALOG_KIND_TEXT.desktop_agent)).toBeTruthy()
    expect(within(tile('erp-lookup')).getByText(CATALOG_KIND_TEXT.skill)).toBeTruthy()
    // Settings scale: the item name at 14px, not the dialog's text-xs.
    expect(within(tile('Invoice Watcher')).getByText('Invoice Watcher').className).toContain('text-[14px]')
  })

  it('a desktop agent’s Get runs the team library’s Get for its repository', async () => {
    mount()
    const get = await waitFor(() => within(tile('Payroll Checker')).getByRole('button', { name: CATALOG_TEXT.get }))
    fireEvent.click(get)
    await waitFor(() => expect(sharingGet).toHaveBeenCalledWith('r-pay'))
  })

  it('an installed cloud agent can be uninstalled from its detail, behind a confirm', async () => {
    mount()
    await waitFor(() => expect(within(tile('Helpdesk')).getByRole('button', { name: CATALOG_TEXT.open })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Helpdesk' }))
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.uninstallLabel('Helpdesk') }))
    const confirm = screen.getByRole('dialog', { name: 'Uninstall Helpdesk' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Uninstall' }))
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith('install-1'))
    // The removal landed: the confirm closes, though the listing still names the install.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Uninstall Helpdesk' })).toBeNull())
    // A cloud agent not installed has nothing to uninstall.
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.back }))
    fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }))
    expect(screen.queryByRole('button', { name: CATALOG_TEXT.uninstallLabel('Invoice Watcher') })).toBeNull()
  })

  it('Back to catalog returns to the place in the grid, with focus on the tile that was opened', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      createElement(
        'div',
        { 'data-settings-scroller': '' },
        createElement(QueryClientProvider, { client }, createElement(CatalogSettingsSection))
      )
    )
    // jsdom does not scroll: the page's scroller keeps whatever is set on it.
    const scroller = document.querySelector<HTMLElement>('[data-settings-scroller]')!
    let top = 0
    Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: (value: number) => (top = value), configurable: true })
    await waitFor(() => expect(tile('Payroll Checker')).toBeTruthy())
    top = 480
    fireEvent.click(screen.getByRole('button', { name: 'Payroll Checker' }))
    expect(screen.getByRole('heading', { name: 'Payroll Checker' })).toBeTruthy()
    // The detail is shorter than the grid: the page clamps its scroll.
    top = 0
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.back }))
    expect(top).toBe(480)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Payroll Checker' }))
  })

  it('a failed uninstall keeps the confirm open, with the reason in it', async () => {
    uninstall.mockRejectedValue(new Error("Error invoking remote method 'catalog:uninstall': CinnaApiError: Not allowed"))
    mount()
    await waitFor(() => expect(within(tile('Helpdesk')).getByRole('button', { name: CATALOG_TEXT.open })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Helpdesk' }))
    fireEvent.click(screen.getByRole('button', { name: CATALOG_TEXT.uninstallLabel('Helpdesk') }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Uninstall Helpdesk' })).getByRole('button', { name: 'Uninstall' }))
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Uninstall Helpdesk' })).getByText('Not allowed')).toBeTruthy())
  })
})
