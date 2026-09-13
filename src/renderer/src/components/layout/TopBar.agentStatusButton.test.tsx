import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the real status query and button so local-account availability,
// header placement and opening's cache refresh are checked together.
vi.mock('../../hooks/useStartNewChat', () => ({ useStartNewChat: () => vi.fn() }))
vi.mock('../chat/JobOriginBanner', () => ({ JobOriginBanner: () => null }))

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { TopBar } = await import('./TopBar')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')

const list = vi.fn()

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  useUIStore.setState({ activeView: 'chat', sidebarOpen: true, agentStatusOpen: false })
  list.mockReset().mockResolvedValue({
    success: true,
    remoteError: null,
    items: [{ agentId: 'folder:alpha', name: 'Alpha', severity: 'error' }]
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    agentStatus: { list },
    inbox: { list: async () => [] }
  }
})

describe('TopBar — agent status', () => {
  it.each(['local_user', 'cinna_user'] as const)(
    'sits between the sidebar toggle and Inbox for a %s account',
    async (type) => {
      useAuthStore.setState({
        currentUser: {
          id: 'u1', type, username: 'u', displayName: 'U',
          hasPassword: false, createdAt: new Date()
        }
      } as never)
      render(createElement(TopBar), { wrapper })

      const status = await screen.findByRole('button', { name: 'Agent status — 1 agent · worst: error' })
      expect(status.previousElementSibling).toBe(screen.getByTitle('Collapse sidebar'))
      expect(status.nextElementSibling).toBe(screen.getByRole('button', { name: 'Inbox' }))
      expect(status.querySelector('span')?.className).toContain('bg-[var(--color-severity-error)]')
    }
  )

  it('remains available after collapsing the sidebar and refetches only when opening status', async () => {
    render(createElement(TopBar), { wrapper })
    const status = await screen.findByRole('button', { name: /worst: error/ })
    expect(list).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTitle('Collapse sidebar'))
    expect(useUIStore.getState().sidebarOpen).toBe(false)
    expect(status.previousElementSibling).toBe(screen.getByTitle('Open sidebar'))
    fireEvent.click(status)
    expect(useUIStore.getState().agentStatusOpen).toBe(true)
    expect(status.getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))

    fireEvent.click(status)
    expect(useUIStore.getState().agentStatusOpen).toBe(false)
    expect(status.getAttribute('aria-pressed')).toBe('false')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('still opens status when no agents have reported, without a severity dot', async () => {
    list.mockResolvedValue({ success: true, remoteError: null, items: [] })
    render(createElement(TopBar), { wrapper })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    const status = screen.getByRole('button', { name: 'Agent status' })
    expect(status.querySelector('span')).toBeNull()
    fireEvent.click(status)
    expect(useUIStore.getState().agentStatusOpen).toBe(true)
  })
})
