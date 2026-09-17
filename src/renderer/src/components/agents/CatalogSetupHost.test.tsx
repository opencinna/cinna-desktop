import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The app-level host for the catalog setup dialog. The sidebar install that
 * raises it may finish after the sidebar list is gone, so the dialog is driven
 * by the install store alone — and belongs to the profile that installed.
 */

vi.mock('../settings/CatalogSetupModal', () => ({
  CatalogSetupModal: ({
    installId,
    agentName,
    onClose,
    onReady
  }: {
    installId: string
    agentName: string
    onClose: () => void
    onReady: () => void
  }) =>
    createElement(
      'div',
      { role: 'dialog', 'aria-label': `Finish setting up ${agentName}`, 'data-install': installId },
      createElement('button', { type: 'button', onClick: onClose }, 'Close'),
      createElement('button', { type: 'button', onClick: onReady }, 'Ready')
    )
}))

window.api = {} as never
const { CatalogSetupHost } = await import('./CatalogSetupHost')
const { useCatalogInstallStore } = await import('../../stores/catalogInstall.store')
const { useAuthStore } = await import('../../stores/auth.store')

const PENDING = { installId: 'inst-1', agentName: 'Invoices', profileId: 'p1' }
let syncRemote: ReturnType<typeof vi.fn>
let client: QueryClient

beforeEach(() => {
  syncRemote = vi.fn().mockResolvedValue({ success: true })
  window.api = { agents: { syncRemote } } as never
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user' } as never })
  useCatalogInstallStore.setState({ installingBundleId: null, error: null, pendingSetup: null })
  client = new QueryClient()
})

const mount = (): void => {
  render(createElement(QueryClientProvider, { client }, createElement(CatalogSetupHost)))
}
const dialog = (): HTMLElement | null =>
  screen.queryByRole('dialog', { name: 'Finish setting up Invoices' })

describe('CatalogSetupHost', () => {
  it('renders nothing until an install asks for setup, then the dialog for it', () => {
    mount()
    expect(dialog()).toBeNull()
    act(() => useCatalogInstallStore.getState().setPendingSetup(PENDING))
    expect(dialog()?.getAttribute('data-install')).toBe('inst-1')
  })

  it('hides under another profile, and comes back under the one that installed', () => {
    useCatalogInstallStore.setState({ pendingSetup: PENDING })
    mount()
    expect(dialog()).toBeTruthy()
    act(() => useAuthStore.setState({ currentUser: { id: 'p2', type: 'cinna_user' } as never }))
    expect(dialog()).toBeNull()
    act(() => useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user' } as never }))
    expect(dialog()).toBeTruthy()
  })

  it('clears on close without refreshing anything', () => {
    useCatalogInstallStore.setState({ pendingSetup: PENDING })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(dialog()).toBeNull()
    expect(useCatalogInstallStore.getState().pendingSetup).toBeNull()
    expect(syncRemote).not.toHaveBeenCalled()
  })

  it('clears once ready and refreshes the catalog state', () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    useCatalogInstallStore.setState({ pendingSetup: PENDING })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Ready' }))
    expect(dialog()).toBeNull()
    expect(useCatalogInstallStore.getState().pendingSetup).toBeNull()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['catalog'] })
    expect(syncRemote).toHaveBeenCalledOnce()
  })
})
