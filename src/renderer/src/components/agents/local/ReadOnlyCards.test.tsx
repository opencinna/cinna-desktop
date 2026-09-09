import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { CommandsCard } from './ReadOnlyCards'

/**
 * The Commands card's "Run" button — the agent page's half of Phase 7a's
 * `/run:<name>` deliverable (the composer's `/` popup is the other half, and
 * is covered by `agentService.listCliCommands.test.ts` and
 * `commandService.test.ts` on the main side; there is nothing renderer-only
 * left to pin for it once a chat exists — see `useCliCommands`/`ChatInput`,
 * unchanged by this phase).
 *
 * `startNewChat`, `setActiveView` and `setSidebarTab` are the three calls this
 * button has to make correctly — everything downstream of them (chat creation,
 * the actual `/run:` dispatch) is already covered elsewhere and is not
 * re-proven here.
 */

const startNewChat = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../hooks/useNewChatFlow', () => ({
  useNewChatFlow: () => ({ startNewChat })
}))

const setActiveView = vi.fn()
const setSidebarTab = vi.fn()
vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (
    selector: (s: {
      setActiveView: typeof setActiveView
      setSidebarTab: typeof setSidebarTab
    }) => unknown
  ) => selector({ setActiveView, setSidebarTab })
}))

// `useOpenAgentPath` is a real react-query mutation calling `window.api` —
// never invoked in these tests (nothing here clicks "reveal"), but the
// mutation hook still needs the shape to exist and a query client to mount.
;(window as unknown as { api: { localAgents: { openPath: () => Promise<void> } } }).api = {
  localAgents: { openPath: async () => undefined }
}

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:alpha',
    name: 'Alpha',
    commands: [
      { name: 'check', description: 'Run the checks', command: 'python scripts/check.py', localCommand: 'uv run scripts/check.py' }
    ],
    ...overrides
  } as LocalAgentDto
}

function renderCard(a: LocalAgentDto): ReturnType<typeof render> {
  const client = new QueryClient()
  return render(
    createElement(QueryClientProvider, { client }, createElement(CommandsCard, { agent: a }))
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('CommandsCard — Run', () => {
  it('switches to the chat view and starts a direct chat sending /run:<name>', async () => {
    renderCard(agent())
    fireEvent.click(screen.getByRole('button', { name: /run/i }))

    expect(setActiveView).toHaveBeenCalledWith('chat')
    // The run leaves the user in a conversation, so the sidebar follows it —
    // the same move both "Start chat" buttons make.
    expect(setSidebarTab).toHaveBeenCalledWith('chats')
    await waitFor(() => expect(startNewChat).toHaveBeenCalledTimes(1))
    expect(startNewChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '/run:check',
        agentIds: ['folder:alpha'],
        mode: null,
        providerId: null,
        mcpIds: []
      })
    )
  })

  it('disables every Run button while one is in flight, and re-enables once it settles', async () => {
    let release!: () => void
    startNewChat.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    renderCard(
      agent({
        commands: [
          { name: 'check', description: '', command: 'x', localCommand: 'x' },
          { name: 'deploy', description: '', command: 'y', localCommand: 'y' }
        ]
      })
    )
    const buttons = () => screen.getAllByRole('button', { name: /run|starting/i }) as HTMLButtonElement[]
    fireEvent.click(buttons()[0])

    await waitFor(() => expect(buttons()[1].disabled).toBe(true))
    expect(buttons()[0].disabled).toBe(true)

    release()
    await waitFor(() => expect(buttons()[1].disabled).toBe(false))
  })

  it('shows the empty-state copy and no Run button when the catalog is empty', () => {
    renderCard(agent({ commands: [] }))
    expect(screen.queryByRole('button', { name: /run/i })).toBeNull()
    expect(screen.getByText(/no commands yet/i)).toBeTruthy()
  })
})
