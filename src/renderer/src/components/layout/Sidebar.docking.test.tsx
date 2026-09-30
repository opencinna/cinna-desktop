import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The sidebar in hover docking: floating, hidden, and peeked from the window's left edge. */

vi.mock('../chat/ChatList', () => ({ ChatList: () => null }))
vi.mock('../jobs/JobsList', () => ({ JobsList: () => null }))
vi.mock('../notes/NotesList', () => ({ NotesList: () => null }))
vi.mock('../agents/local/LocalAgentsList', () => ({ LocalAgentsList: () => null }))
vi.mock('./SidebarTabs', () => ({ SidebarTabs: () => null }))
vi.mock('../auth/UserMenu', () => ({ UserMenu: () => null }))
vi.mock('../updater/UpdateStatusButton', () => ({ UpdateStatusButton: () => null }))
vi.mock('../localdev/LocalDevStatusButton', () => ({ LocalDevStatusButton: () => null }))
vi.mock('./InterfaceMenu', () => ({ InterfaceMenu: () => null }))

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { Sidebar } = await import('./Sidebar')
const { useUIStore } = await import('../../stores/ui.store')
const { PEEK_OPEN_DELAY_MS, PEEK_CLOSE_DELAY_MS } = await import('../../hooks/useSidebarHoverDock')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

const wrap = (container: HTMLElement): HTMLElement => container.querySelector('.app-sidebar-wrap') as HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  useUIStore.setState({ activeView: 'chat', sidebarOpen: true, sidebarDocking: 'fixed', sidebarPeek: false })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Sidebar docking', () => {
  it('in fixed docking takes its width and has no edge band', () => {
    const { container } = render(createElement(Sidebar), { wrapper })
    expect(wrap(container).className).not.toContain('is-floating')
    expect(wrap(container).className).not.toContain('is-collapsed')
    expect(screen.queryByTestId('sidebar-hot-zone')).toBeNull()
  })

  it('in hover docking floats hidden, peeks from the edge band and hides after the pointer leaves', () => {
    useUIStore.setState({ sidebarDocking: 'hover' })
    const { container } = render(createElement(Sidebar), { wrapper })
    expect(wrap(container).className).toContain('is-floating')
    expect(wrap(container).className).toContain('is-collapsed')

    // The band is portaled out of the transformed wrap, into body. It takes no
    // pointer events; a move over the chat inside its rect is what counts.
    const zone = screen.getByTestId('sidebar-hot-zone')
    expect(zone.parentElement).toBe(document.body)
    vi.spyOn(zone, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 44, right: 142, bottom: 800, x: 0, y: 44, width: 142, height: 756, toJSON: () => ({})
    } as DOMRect)
    fireEvent.mouseMove(document.body, { clientX: 40, clientY: 400 })
    act(() => {
      vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS)
    })
    expect(useUIStore.getState().sidebarPeek).toBe(true)
    expect(wrap(container).className).not.toContain('is-collapsed')
    expect(wrap(container).className).toContain('is-floating')
    // No band while it is showing.
    expect(screen.queryByTestId('sidebar-hot-zone')).toBeNull()
    // The fixed open state is left alone.
    expect(useUIStore.getState().sidebarOpen).toBe(true)

    // Pointer on the card, then off to the chat.
    fireEvent.mouseMove(container.querySelector('.app-sidebar') as HTMLElement)
    fireEvent.mouseMove(document.body)
    act(() => {
      vi.advanceTimersByTime(PEEK_CLOSE_DELAY_MS)
    })
    expect(useUIStore.getState().sidebarPeek).toBe(false)
    expect(wrap(container).className).toContain('is-collapsed')
    expect(screen.getByTestId('sidebar-hot-zone')).toBeTruthy()
  })
})
