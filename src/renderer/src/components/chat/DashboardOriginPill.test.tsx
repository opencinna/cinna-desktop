import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { DashboardOriginPill, DashboardOriginRowMark } from './DashboardOriginPill'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'

let dashboards: Array<{ id: string; name: string }> = []
const list = vi.fn(async () => dashboards)

function show(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  dashboards = [{ id: 'd1', name: 'Sales overview' }]
  list.mockClear()
  window.api = {
    dashboards: { list },
    chat: {
      get: async (chatId: string) => ({ id: chatId, title: 'Chat', router: 'direct', agentId: 'a', messages: [], originatingJobRunId: null, originDashboardId: chatId === 'from-dash' ? 'd1' : null }),
      onTitleUpdated: () => () => {}
    }
  } as never
  useUIStore.setState({ activeView: 'chat', activeDashboardId: null, sidebarTab: 'chats' })
})

describe('"From dashboard" in the chat header', () => {
  it('names the dashboard a panel chat started on, and opens it', async () => {
    useChatStore.getState().setActiveChatId('from-dash')
    show(<DashboardOriginPill />)
    const pill = await screen.findByRole('button', { name: /From dashboard\s*Sales overview/ })
    fireEvent.click(pill)
    expect(useUIStore.getState()).toMatchObject({ activeView: 'dashboard', activeDashboardId: 'd1', sidebarTab: 'dashboards' })
  })

  it('is hidden for an ordinary chat, and when the dashboard is gone', async () => {
    useChatStore.getState().setActiveChatId('plain')
    const { unmount } = show(<DashboardOriginPill />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('button')).toBeNull()
    expect(list).not.toHaveBeenCalled()
    unmount()

    dashboards = []
    useChatStore.getState().setActiveChatId('from-dash')
    show(<DashboardOriginPill />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('"From dashboard" on the Chats row', () => {
  it('is a named mark that opens the dashboard, not the chat', async () => {
    const onRow = vi.fn()
    show(
      <div onClick={onRow}>
        <DashboardOriginRowMark dashboardId="d1" />
      </div>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'From dashboard Sales overview' }))
    expect(onRow).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeView).toBe('dashboard')
  })

  it('shows nothing without a dashboard, or for one that no longer exists', async () => {
    dashboards = []
    show(
      <>
        <DashboardOriginRowMark dashboardId={null} />
        <DashboardOriginRowMark dashboardId="d1" />
      </>
    )
    await waitFor(() => expect(list).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('button')).toBeNull()
  })
})
