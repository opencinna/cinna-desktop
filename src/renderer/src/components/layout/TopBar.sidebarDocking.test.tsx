import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../hooks/useStartNewChat', () => ({ useStartNewChat: () => vi.fn() }))
vi.mock('../chat/JobOriginBanner', () => ({ JobOriginBanner: () => null }))
vi.mock('../inbox/InboxButton', () => ({ InboxButton: () => null }))
vi.mock('../agents/AgentStatusButton', () => ({ AgentStatusButton: () => null }))
vi.mock('../updater/UpdateStatusButton', () => ({ UpdateStatusButton: () => null }))

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { TopBar } = await import('./TopBar')
const { useUIStore } = await import('../../stores/ui.store')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  localStorage.removeItem('cinna-sidebar-docking')
  useUIStore.setState({ sidebarOpen: true, sidebarDocking: 'fixed', sidebarPeek: false })
})

describe('TopBar — sidebar docking', () => {
  it('toggles the sidebar in fixed docking', () => {
    render(createElement(TopBar), { wrapper })
    fireEvent.click(screen.getByTitle('Collapse sidebar'))
    expect(useUIStore.getState().sidebarOpen).toBe(false)
    fireEvent.click(screen.getByTitle('Open sidebar'))
    expect(useUIStore.getState().sidebarOpen).toBe(true)
  })

  it('docks the sidebar open from hover docking', () => {
    useUIStore.setState({ sidebarDocking: 'hover', sidebarOpen: false })
    render(createElement(TopBar), { wrapper })
    fireEvent.click(screen.getByTitle('Dock sidebar'))
    const state = useUIStore.getState()
    expect(state.sidebarDocking).toBe('fixed')
    expect(state.sidebarOpen).toBe(true)
    expect(screen.getByTitle('Collapse sidebar')).toBeTruthy()
  })

  it('flips the docking mode with one Show sidebar on hover switch in a right-click menu that stays open', () => {
    render(createElement(TopBar), { wrapper })
    const button = screen.getByTitle('Collapse sidebar')
    act(() => {
      fireEvent.contextMenu(button)
    })
    const menu = screen.getByRole('menu', { name: 'Sidebar docking' })
    // One switch row, not a Fixed / On Hover radio pair.
    expect(within(menu).queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(within(menu).queryByText('Fixed')).toBeNull()
    const onHover = within(menu).getByRole('menuitemcheckbox', { name: 'Show sidebar on hover' })
    expect(onHover.getAttribute('aria-checked')).toBe('false')
    // The switch row takes focus on opening, as the chat-list menu's first item does.
    expect(document.activeElement).toBe(onHover)
    expect(onHover.querySelector('[data-switch-track]')?.getAttribute('data-switch-track')).toBe('off')
    // The right-click did not also toggle the sidebar.
    expect(useUIStore.getState().sidebarOpen).toBe(true)

    fireEvent.click(onHover)
    expect(useUIStore.getState().sidebarDocking).toBe('hover')
    expect(localStorage.getItem('cinna-sidebar-docking')).toBe('hover')
    expect(screen.getByTitle('Dock sidebar')).toBeTruthy()
    // Still open, so the switch is seen to move.
    const switched = within(screen.getByRole('menu', { name: 'Sidebar docking' })).getByRole('menuitemcheckbox', { name: 'Show sidebar on hover' })
    expect(switched.getAttribute('aria-checked')).toBe('true')
    expect(switched.querySelector('[data-switch-track]')?.getAttribute('data-switch-track')).toBe('on')

    // Toggling back returns to fixed docking.
    fireEvent.click(switched)
    expect(useUIStore.getState().sidebarDocking).toBe('fixed')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show sidebar on hover' }).getAttribute('aria-checked')).toBe('false')

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByRole('menu', { name: 'Sidebar docking' })).toBeNull()
    // Escape gives focus back to the sidebar button.
    expect(document.activeElement).toBe(button)

    act(() => {
      useUIStore.setState({ sidebarDocking: 'hover', sidebarOpen: false })
    })
    act(() => {
      fireEvent.contextMenu(screen.getByTitle('Dock sidebar'))
    })
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show sidebar on hover' }).getAttribute('aria-checked')).toBe('true')
  })
})
