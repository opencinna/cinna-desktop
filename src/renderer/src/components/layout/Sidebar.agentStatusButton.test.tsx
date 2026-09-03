import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * The sidebar footer's agent-status button — the **only** way into the status
 * overlay, and so into "Refresh all".
 *
 * It was rendered behind `{isCinnaUser && …}`, which is the same "gate above the
 * branch that would otherwise show something" shape as `agentStatusService`'s
 * remote-only filter and `useAgentStatus`'s account gate. A folder agent reports
 * a status with no Cinna account at all, so a local-only user could have agents
 * to see and no door to see them through.
 *
 * Everything in the sidebar except the button under test is stubbed: the point
 * is which children render for which account, not what any of them contain.
 */

vi.mock('../chat/ChatList', () => ({ ChatList: () => null }))
vi.mock('../jobs/JobsList', () => ({ JobsList: () => null }))
vi.mock('../notes/NotesList', () => ({ NotesList: () => null }))
vi.mock('../agents/local/LocalAgentsList', () => ({ LocalAgentsList: () => null }))
vi.mock('./SidebarTabs', () => ({ SidebarTabs: () => null }))
vi.mock('../auth/UserMenu', () => ({ UserMenu: () => null }))
vi.mock('../updater/UpdateStatusButton', () => ({ UpdateStatusButton: () => null }))
vi.mock('./InterfaceMenu', () => ({ InterfaceMenu: () => null }))

// `ui.store.ts` calls `window.api.app.setTheme(...)` at module scope, so the
// bridge has to exist before the first import of anything that pulls it in.
;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { Sidebar } = await import('./Sidebar')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

function signInAs(type: 'local_user' | 'cinna_user'): void {
  useAuthStore.setState({
    currentUser: {
      id: 'u1',
      type,
      username: 'u',
      displayName: 'U',
      hasPassword: false,
      createdAt: new Date()
    }
  } as never)
}

beforeEach(() => {
  useUIStore.setState({ activeView: 'chat', settingsMenu: 'chats' } as never)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    agentStatus: {
      list: vi.fn().mockResolvedValue({
        success: true,
        remoteError: null,
        items: [
          {
            agentId: 'folder:alpha',
            remoteAgentId: 'folder:alpha',
            name: 'Alpha',
            environmentId: 'local',
            severity: 'error',
            summary: 'disk full',
            reportedAt: null,
            reportedAtSource: null,
            fetchedAt: null,
            raw: null,
            body: '',
            hasStructuredMetadata: true,
            prevSeverity: null,
            severityChangedAt: null
          }
        ]
      }),
      get: vi.fn()
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Sidebar — the agent status button', () => {
  it('is there for a purely local account, which can still have folder agents', async () => {
    signInAs('local_user')
    render(createElement(Sidebar), { wrapper })

    const button = await screen.findByTitle(/Agent status/)
    // Consequence: the door into the overlay exists, and it reports what the
    // user's one folder agent said.
    await waitFor(() =>
      expect(button.getAttribute('title')).toContain('worst: error')
    )
  })

  it('is still there for a cinna account', () => {
    signInAs('cinna_user')
    render(createElement(Sidebar), { wrapper })
    expect(screen.getByTitle(/Agent status/)).toBeTruthy()
  })
})
