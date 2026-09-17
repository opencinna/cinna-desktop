import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogEntryDto } from '../../../../shared/catalog'

/**
 * The Agent Catalog dialog: a grid of every published bundle, a detail view
 * behind each tile, and an Install / Open action whose install the parent
 * runs. What has to hold is that the action lands in the right tile — the
 * spinner, the disabled siblings and the error all belong to one bundle.
 */

vi.mock('../settings/CatalogCardCredentials', () => ({
  CatalogCardCredentials: ({
    entry,
    enabled,
    compact
  }: {
    entry: CatalogEntryDto
    enabled: boolean
    compact?: boolean
  }) =>
    createElement(
      'div',
      { 'data-testid': 'credentials' },
      `${entry.bundleId}:${enabled}:${compact ? 'compact' : 'full'}`
    )
}))

window.api = {} as never
const { CatalogBrowserModal } = await import('./CatalogBrowserModal')
const { useAuthStore } = await import('../../stores/auth.store')
const { SETTLE_MS } = await import('../../hooks/useSettleGuard')

function entry(overrides: Partial<CatalogEntryDto>): CatalogEntryDto {
  return {
    bundleId: 'bundle',
    bundleUuid: 'uuid',
    displayName: 'Bundle',
    description: null,
    publisherName: null,
    publisherEmail: null,
    publisherHandle: null,
    visibility: 'public',
    latestVersion: '1.0.0',
    latestRevisionNumber: 1,
    latestPublishedAt: null,
    installCount: 0,
    isInstalled: false,
    userInstallId: null,
    pendingUpdate: false,
    requiredCredentialSpecs: [],
    ...overrides
  }
}

const INVOICES = entry({
  bundleId: 'acme/invoices',
  displayName: 'Invoice Watcher',
  description: 'Flags invoices without a PO number.',
  publisherName: 'Acme',
  publisherEmail: 'ops@acme.test',
  installCount: 12,
  latestPublishedAt: '2026-03-01T00:00:00Z'
})
const RATES = entry({
  bundleId: 'fx/rates',
  displayName: 'Exchange Rates',
  description: 'Daily FX digest.',
  publisherName: 'FX Corp',
  installCount: 1
})
const HELPDESK = entry({
  bundleId: 'acme/helpdesk',
  displayName: 'Helpdesk',
  publisherName: 'Acme',
  isInstalled: true,
  userInstallId: 'install-1',
  latestVersion: null,
  latestRevisionNumber: 4
})

let catalogList: ReturnType<typeof vi.fn>
const onClose = vi.fn()
const onInstall = vi.fn()
const onOpen = vi.fn()
const cinnaReauth = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  useAuthStore.setState({
    currentUser: {
      id: 'p1',
      type: 'cinna_user',
      username: 'u',
      displayName: 'U',
      hasPassword: false
    } as never
  })
  catalogList = vi.fn().mockResolvedValue({ success: true, value: [INVOICES, RATES, HELPDESK] })
  window.api = {
    catalog: { list: catalogList },
    agents: {
      list: vi.fn().mockResolvedValue([
        { id: 'remote:helpdesk', name: 'Helpdesk', source: 'remote', remoteTargetId: 'install-1' }
      ]),
      syncRemote: vi.fn().mockResolvedValue(undefined),
      onRemoteSyncComplete: () => () => {},
      onReadinessChanged: () => () => {}
    },
    auth: { cinnaReauth }
  } as never
})

function mount(props: Partial<Parameters<typeof CatalogBrowserModal>[0]> = {}): {
  rerender: (next: Partial<Parameters<typeof CatalogBrowserModal>[0]>) => void
} {
  // `useCatalog` sets its own retry (none for an expired session); no delay
  // between the attempts keeps a plain failure fast here.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })
  const base = { onClose, onInstall, onOpen, installingBundleId: null, installError: null }
  const tree = (p: typeof props): React.JSX.Element =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(CatalogBrowserModal, { ...base, ...p })
    )
  const view = render(tree(props))
  return { rerender: (next) => view.rerender(tree(next)) }
}

const tile = (name: string): HTMLElement => screen.getByRole('group', { name })

describe('CatalogBrowserModal', () => {
  it('shows every bundle, installed ones marked, with count and version', async () => {
    mount()
    expect(screen.getByRole('dialog', { name: 'Agent catalog' })).toBeTruthy()
    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(3))
    const invoices = tile('Invoice Watcher')
    expect(within(invoices).getByRole('button', { name: 'Invoice Watcher' })).toBeTruthy()
    expect(within(invoices).getByText('v1.0.0')).toBeTruthy()
    expect(within(invoices).getByText('by Acme')).toBeTruthy()
    expect(within(invoices).getByText('12 installs')).toBeTruthy()
    expect(within(tile('Exchange Rates')).getByText('1 install')).toBeTruthy()
    const helpdesk = tile('Helpdesk')
    expect(within(helpdesk).getByText('Installed')).toBeTruthy()
    expect(within(helpdesk).getByText('rev 4')).toBeTruthy()
    expect(within(helpdesk).queryByRole('button', { name: /Install/ })).toBeNull()
  })

  it('filters by name, description, publisher and bundle id', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(3))
    const search = screen.getByRole('textbox', { name: 'Search the catalog' })
    const names = (): string[] => screen.queryAllByRole('group').map((g) => g.getAttribute('aria-label')!)
    fireEvent.change(search, { target: { value: 'ACME' } })
    expect(names()).toEqual(['Invoice Watcher', 'Helpdesk'])
    fireEvent.change(search, { target: { value: 'rates digest' } })
    expect(names()).toEqual([])
    expect(screen.getByText('No agents match your search.')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'fx/' } })
    expect(names()).toEqual(['Exchange Rates'])
    fireEvent.change(search, { target: { value: 'po number' } })
    expect(names()).toEqual(['Invoice Watcher'])
  })

  it('opens a detail from the tile and Back returns to the same search', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(3))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the catalog' }), {
      target: { value: 'invoice' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }))

    expect(screen.getByRole('heading', { name: 'Invoice Watcher' })).toBeTruthy()
    expect(screen.getByText('ops@acme.test', { exact: false })).toBeTruthy()
    expect(screen.getByText('acme/invoices')).toBeTruthy()
    expect(screen.getByText(new Date('2026-03-01T00:00:00Z').toLocaleDateString())).toBeTruthy()
    // One step down the type scale inside the dialog.
    expect(screen.getByTestId('credentials').textContent).toBe('acme/invoices:true:compact')
    // Still mounted under the detail, but out of reach.
    expect(screen.queryByRole('textbox', { name: 'Search the catalog' })).toBeNull()
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to catalog' }))

    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(onInstall).toHaveBeenCalledWith('acme/invoices')

    fireEvent.click(screen.getByRole('button', { name: 'Back to catalog' }))
    const search = screen.getByRole('textbox', { name: 'Search the catalog' }) as HTMLInputElement
    expect(search.value).toBe('invoice')
    expect(document.activeElement).toBe(search)
    expect(screen.getAllByRole('group')).toHaveLength(1)
  })

  it('keeps the grid mounted behind a detail, so its scroll position survives', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(3))
    const grid = tile('Invoice Watcher')
    fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }))
    expect(grid.isConnected).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Back to catalog' }))
    expect(tile('Invoice Watcher')).toBe(grid)
  })

  describe('right after a detail opens', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('ignores a pointer click on Install until the view has settled', async () => {
      mount()
      await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(3))
      fireEvent.click(screen.getByRole('button', { name: 'Invoice Watcher' }), { detail: 1 })
      // The second half of the double-click that opened the detail.
      fireEvent.click(screen.getByRole('button', { name: 'Install' }), { detail: 2 })
      expect(onInstall).not.toHaveBeenCalled()
      // Enter on the focused button is deliberate, settled or not.
      fireEvent.click(screen.getByRole('button', { name: 'Install' }), { detail: 0 })
      expect(onInstall).toHaveBeenCalledTimes(1)
      act(() => vi.advanceTimersByTime(SETTLE_MS))
      fireEvent.click(screen.getByRole('button', { name: 'Install' }), { detail: 1 })
      expect(onInstall).toHaveBeenCalledTimes(2)
    })

    it('ignores a pointer click on Open until the view has settled', async () => {
      mount()
      await waitFor(() =>
        expect(within(tile('Helpdesk')).getByRole('button', { name: 'Open' })).toBeTruthy()
      )
      fireEvent.click(screen.getByRole('button', { name: 'Helpdesk' }), { detail: 1 })
      fireEvent.click(screen.getByRole('button', { name: 'Open' }), { detail: 2 })
      expect(onOpen).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(SETTLE_MS))
      fireEvent.click(screen.getByRole('button', { name: 'Open' }), { detail: 1 })
      expect(onOpen).toHaveBeenCalledWith('remote:helpdesk')
    })
  })

  it('installs from the tile, and while one runs every Install is disabled', async () => {
    const view = mount()
    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(3))
    fireEvent.click(within(tile('Exchange Rates')).getByRole('button', { name: 'Install' }))
    expect(onInstall).toHaveBeenCalledWith('fx/rates')

    view.rerender({ installingBundleId: 'fx/rates' })
    const running = within(tile('Exchange Rates')).getByRole('button', { name: 'Installing…' })
    expect((running as HTMLButtonElement).disabled).toBe(true)
    const other = within(tile('Invoice Watcher')).getByRole('button', { name: 'Install' })
    expect((other as HTMLButtonElement).disabled).toBe(true)
    // Says why it is disabled; the running one needs no such note.
    expect(other.getAttribute('title')).toBe('Another agent is installing')
    expect(running.getAttribute('title')).toBeNull()
  })

  it('offers Open on an installed bundle that has synced, and passes its agent id', async () => {
    mount()
    const open = await waitFor(() => within(tile('Helpdesk')).getByRole('button', { name: 'Open' }))
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledWith('remote:helpdesk')
  })

  it('has no Open for an installed bundle with no local agent yet', async () => {
    ;(window.api.agents.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    mount()
    await waitFor(() => expect(within(tile('Helpdesk')).getByText('Installed')).toBeTruthy())
    expect(within(tile('Helpdesk')).queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('shows an install error inside the tile it belongs to, and only there', async () => {
    mount({ installError: { bundleId: 'fx/rates', message: 'Quota reached.' } })
    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(3))
    expect(within(tile('Exchange Rates')).getByRole('alert').textContent).toBe('Quota reached.')
    expect(within(tile('Invoice Watcher')).queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('says so when nothing is published', async () => {
    catalogList.mockResolvedValue({ success: true, value: [] })
    mount()
    expect(await screen.findByText('No agents are published to your account yet.')).toBeTruthy()
  })

  it('offers Re-authenticate when the session expired, and reloads after it', async () => {
    // The shape main really sends: the code as data, not on a thrown error.
    catalogList.mockResolvedValue({ success: false, code: 'reauth_required', message: 'expired' })
    cinnaReauth.mockResolvedValue({ success: false, error: 'Browser closed.' })
    mount()
    const button = await screen.findByRole('button', { name: 'Re-authenticate' })
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    // An expired session is not retried: asking again cannot succeed.
    expect(catalogList).toHaveBeenCalledTimes(1)
    fireEvent.click(button)
    expect(await screen.findByText('Browser closed.')).toBeTruthy()
  })

  it('offers Retry for any other load failure', async () => {
    catalogList.mockRejectedValue(new Error('boom'))
    mount()
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.queryByRole('button', { name: 'Re-authenticate' })).toBeNull()
    catalogList.mockResolvedValue({ success: true, value: [RATES] })
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(1))
  })

  it('closes on Escape and on a click outside', () => {
    mount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Agent catalog' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
