import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

  it('picks the docking mode from a right-click menu that marks the current one', () => {
    render(createElement(TopBar), { wrapper })
    const button = screen.getByTitle('Collapse sidebar')
    act(() => {
      fireEvent.contextMenu(button)
    })
    const menu = screen.getByRole('menu', { name: 'Sidebar docking' })
    expect(menu).toBeTruthy()
    const fixed = screen.getByRole('menuitemradio', { name: 'Fixed' })
    const hover = screen.getByRole('menuitemradio', { name: 'On Hover' })
    expect(fixed.getAttribute('aria-checked')).toBe('true')
    expect(fixed.querySelector('svg')).toBeTruthy()
    expect(hover.getAttribute('aria-checked')).toBe('false')
    expect(hover.querySelector('svg')).toBeNull()
    // The right-click did not also toggle the sidebar.
    expect(useUIStore.getState().sidebarOpen).toBe(true)

    fireEvent.click(hover)
    expect(useUIStore.getState().sidebarDocking).toBe('hover')
    expect(localStorage.getItem('cinna-sidebar-docking')).toBe('hover')
    expect(screen.queryByRole('menu', { name: 'Sidebar docking' })).toBeNull()
    expect(screen.getByTitle('Dock sidebar')).toBeTruthy()

    act(() => {
      fireEvent.contextMenu(screen.getByTitle('Dock sidebar'))
    })
    expect(screen.getByRole('menuitemradio', { name: 'On Hover' }).getAttribute('aria-checked')).toBe('true')
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByRole('menu', { name: 'Sidebar docking' })).toBeNull()
  })
})
