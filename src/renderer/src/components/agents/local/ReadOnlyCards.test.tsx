import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { CommandsCard, CredentialsCard } from './ReadOnlyCards'

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

/** Main's per-slot setup answer, which names the account a held slot comes from. */
const setup = vi.hoisted(() => ({ value: undefined as unknown }))
vi.mock('../../../hooks/useServiceCredentials', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCredentialSetup: (_id: string, enabled: boolean) => ({ data: enabled ? setup.value : undefined })
}))

// `useOpenAgentPath` is a real react-query mutation calling `window.api` —
// never invoked in these tests (nothing here clicks "reveal"), but the
// mutation hook still needs the shape to exist and a query client to mount.
;(
  window as unknown as {
    api: {
      localAgents: {
        openPath: () => Promise<void>
        openCredentials: () => Promise<{ created: boolean; revealed: boolean }>
      }
    }
  }
).api = {
  localAgents: {
    openPath: async () => undefined,
    openCredentials: async () => ({ created: false, revealed: false })
  }
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

describe('CredentialsCard — a slot an unavailable account holds', () => {
  const slot = (over: Record<string, unknown> = {}) => ({
    name: 'Vendor Portal', type: 'api_token', optional: false, envPrefix: 'VENDOR_', expectedKeys: ['VENDOR_TOKEN'], presentKeys: [], satisfied: false, attachment: null, ...over
  })
  const card = (credentials: unknown[]) => render(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(CredentialsCard, { agent: agent({ credentials } as never), env: null })))

  it('says whose it is in the warning tone, not a missing dash', () => {
    setup.value = { slots: [{ name: 'Vendor Portal', state: 'account_unavailable', account: { key: 'k', userId: 'u', name: 'Alice Whitfield', email: 'a@corp.com', host: 'core.corp', reason: 'signed_out', current: false, credentials: 1, aiCredential: false } }] }
    try {
      card([slot({ attachment: { credentialId: 'r', state: 'account_unavailable' } })])
      const label = screen.getByTestId('held-slot-label')
      expect(label.textContent).toBe('Alice is signed out')
      expect(label.className).toContain('--color-warning')
      expect(label.getAttribute('title')).toBe('Alice is signed out: its credential comes from that account. (Alice Whitfield <a@corp.com> core.corp)')
    } finally { setup.value = undefined }
  })

  it('says nothing of an account for a slot that is simply missing', () => {
    card([slot()])
    expect(screen.queryByTestId('held-slot-label')).toBeNull()
  })
})
