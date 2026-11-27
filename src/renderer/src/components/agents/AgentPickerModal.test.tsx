import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The picker's catalog section: a catalog card carries Install, with Details
 * on its left once main has a page, and reading that page keeps the picker.
 */

const get = vi.fn()
window.api = { agentDetails: { get, openFrame: vi.fn(), releaseFrame: vi.fn(), onEscape: () => () => {} } } as never

const { AgentPickerModal } = await import('./AgentPickerModal')
const { useAuthStore } = await import('../../stores/auth.store')
const { CATALOG_TEXT } = await import('../../utils/catalogItems')

const onClose = vi.fn()
const onInstallCatalog = vi.fn()

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AgentPickerModal, {
        open: true,
        items: [],
        onClose,
        multiSelect: true,
        selectedIds: new Set<string>(),
        onToggle: vi.fn(),
        catalogItems: [
          { id: 'u-weather', kind: 'cloud_agent', name: 'Weather Desk' },
          { id: 'u-plain', kind: 'desktop_agent', name: 'Plain Desk' }
        ],
        onInstallCatalog
      })
    )
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ currentUser: { id: 'p1', type: 'cinna_user' } as never })
  get.mockImplementation(async (target: { itemUuid: string }) =>
    target.itemUuid === 'u-weather'
      ? { ok: true, details: { source: 'generated', format: 'markdown', markdown: '## About\n\nForecasts.', generated: null, warnings: [], revisionNumber: 1 } }
      : { ok: false, code: 'not_found', message: 'This agent has no Details page.' })
})

describe('AgentPickerModal — a catalog card', () => {
  it('offers Details left of Install when the item has a page, and none otherwise', async () => {
    mount()
    const card = screen.getByRole('group', { name: 'Weather Desk' })
    const details = await within(card).findByRole('button', { name: 'Details of Weather Desk' })
    expect(within(details.parentElement!).getAllByRole('button').map((b) => b.textContent)).toEqual(['Details', CATALOG_TEXT.get])
    expect(get).toHaveBeenCalledWith({ kind: 'catalog', itemUuid: 'u-weather' })
    await waitFor(() => expect(get).toHaveBeenCalledWith({ kind: 'catalog', itemUuid: 'u-plain' }))
    const plain = screen.getByRole('group', { name: 'Plain Desk' })
    expect(within(plain).queryByRole('button', { name: /^Details of/ })).toBeNull()
    fireEvent.click(within(plain).getByRole('button', { name: CATALOG_TEXT.get }))
    expect(onInstallCatalog).toHaveBeenCalledWith('u-plain')
  })

  it('opens the Details modal, and a click or Escape inside it closes only the modal', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Details of Weather Desk' }))
    const modal = await screen.findByRole('dialog', { name: 'Details: Weather Desk' })
    const text = await within(modal).findByText('Forecasts.')
    fireEvent.mouseDown(text)
    expect(onClose).not.toHaveBeenCalled()
    expect(onInstallCatalog).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Details: Weather Desk' })).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Weather Desk' })).toBeTruthy()
  })
})
