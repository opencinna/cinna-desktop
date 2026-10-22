import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinderQuickActionResult, FinderQuickActionStatus } from '../../../../shared/finderQuickAction'

const api = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn()
}))
;(window as unknown as { api: unknown }).api = { finderQuickAction: api }

const { FinderQuickActionSection } = await import('./FinderQuickActionSection')

const OFF: FinderQuickActionStatus = { supported: true, installed: false, outdated: false }
const ON: FinderQuickActionStatus = { supported: true, installed: true, outdated: false }

function mount(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  render(createElement(FinderQuickActionSection), { wrapper })
  return client
}

// jsdom lays nothing out and has no scrollIntoView.
const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

const toggle = (): HTMLElement => screen.getByRole('switch', { name: 'Mention in Cinna' })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Features → OS Integration', () => {
  it('renders nothing where the Quick Action is not supported', async () => {
    api.status.mockResolvedValue({ supported: false, installed: false, outdated: false })
    const client = mount()
    await waitFor(() => expect(client.getQueryState(['finder-quick-action', 'status'])?.status).toBe('success'))
    expect(screen.queryByRole('heading', { name: 'OS Integration' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('is a titled section whose switch installs, and then removes, the Quick Action', async () => {
    api.status.mockResolvedValue(OFF)
    api.install.mockResolvedValue({ success: true, status: ON } satisfies FinderQuickActionResult)
    api.uninstall.mockResolvedValue({ success: true, status: OFF } satisfies FinderQuickActionResult)
    mount()
    expect(await screen.findByRole('heading', { name: 'OS Integration' })).toBeTruthy()
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    // The how-to is behind the (?), not on the surface.
    expect(screen.queryByText(/Quick Actions or Services/)).toBeNull()

    fireEvent.click(toggle())
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'))
    expect(api.install).toHaveBeenCalledTimes(1)

    fireEvent.click(toggle())
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'))
    expect(api.uninstall).toHaveBeenCalledTimes(1)
  })

  it('says why under the switch when installing fails, scrolls it into view, and leaves the switch as it was', async () => {
    api.status.mockResolvedValue(OFF)
    api.install.mockResolvedValue({ success: false, error: 'Cinna can’t write to ~/Library/Services.', status: OFF })
    mount()
    fireEvent.click(await screen.findByRole('switch', { name: 'Mention in Cinna' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Cinna can’t write to ~/Library/Services.')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    // The last section of the tab: the row would otherwise render below the window edge.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(alert)
  })

  it('offers Update for an installed copy that is out of date, saying Updating… while it runs', async () => {
    api.status.mockResolvedValue({ ...ON, outdated: true })
    let finish!: (result: FinderQuickActionResult) => void
    api.install.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    mount()
    expect(await screen.findByText('Installed from an older Cinna.')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    const updating = await screen.findByRole('button', { name: 'Updating…' })
    expect((updating as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ success: true, status: ON }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Update' })).toBeNull())
    expect(api.install).toHaveBeenCalledTimes(1)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })
})
