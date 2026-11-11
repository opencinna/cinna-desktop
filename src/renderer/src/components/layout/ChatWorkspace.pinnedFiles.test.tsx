import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import { forwardRef } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'

/**
 * The Pinned files card in the chat workspace: on the main chat view, for a
 * chat whose root agent is a folder agent, and nowhere else.
 */

const spy = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => {} } } as never
  return {
    agents: [] as Array<{ id: string; capabilities: { cwd: boolean } }>,
    chat: null as null | { id: string; agentId: string | null }
  }
})
vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../hooks/useAppSettings', () => ({ useAppSettings: () => ({ data: { defaultMultiAgentRouting: 'human' } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: spy.agents }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }), useDefaultChatMode: () => ({ data: null }) }))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useHintsEnabled', () => ({ useHintsEnabled: () => false }))
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: vi.fn() }), resolveModel: () => null }))
vi.mock('../../hooks/useApplyChatMode', () => ({ useApplyChatMode: () => vi.fn() }))
vi.mock('../../hooks/useNewChatLike', () => ({ useNewChatLike: () => vi.fn(async () => undefined) }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: (chatId: string | null) => ({ data: chatId ? spy.chat : null }) }))
vi.mock('../tasks/PendingHandoffControl', () => ({ useChatHandoffPending: () => false }))
vi.mock('../chat/MessageStream', () => ({ MessageStream: () => <output data-testid="stream" /> }))
vi.mock('../ui/HintBar', () => ({ HintBar: () => null }))
vi.mock('../chat/DesktopAppsBanner', () => ({ DesktopAppsBanner: () => null }))
vi.mock('../chat/ExamplePromptTags', () => ({ ExamplePromptTags: () => null }))
vi.mock('../chat/ComposerReadiness', () => ({ RefusableExamplePrompts: ({ children }: { children: React.ReactNode }) => children, readinessRefusal: () => null, usePickedFolder: () => ({ folder: null, pending: false }) }))
vi.mock('../chat/ChatInput', () => ({
  ChatInput: forwardRef(function ChatInput() {
    return <textarea aria-label="Message" />
  })
}))
const { ChatWorkspace } = await import('./ChatWorkspace')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')

const listPins = vi.fn()

beforeEach(() => {
  listPins.mockReset().mockResolvedValue({ success: true, pins: [{ path: '/agent/plan.md', displayPath: 'plan.md', inside: true, rank: 1, exists: true }] })
  window.api = { app: { setTheme: async () => {} }, agentFiles: { listPins } } as never
  window.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as never
  spy.agents = [{ id: 'folder:a', capabilities: { cwd: true } }, { id: 'remote:b', capabilities: { cwd: false } }]
  spy.chat = { id: 'chat-1', agentId: 'folder:a' }
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ activeView: 'chat', minimalView: false, pendingAgentId: null, pendingModeId: null, draftingAgentIds: [] })
  act(() => useChatStore.getState().setActiveChatId('chat-1'))
})

function mount(ui: React.ReactNode = <ChatWorkspace />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const card = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-pinned-files-card]')

it('shows the root folder agent’s pins over the chat area, beside the transcript', async () => {
  mount()
  await waitFor(() => expect(card()).not.toBeNull())
  expect(listPins).toHaveBeenCalledWith({ agentId: 'folder:a' })
  // An overlay in the chat area, not a block in the column the transcript lays out in.
  expect(card()!.parentElement).toBe(document.querySelector('[data-testid="stream"]')!.parentElement)
  expect(card()!.className).toContain('absolute')
})

it('shows nothing for a chat whose root agent is not a folder agent', async () => {
  spy.chat = { id: 'chat-1', agentId: 'remote:b' }
  mount()
  await act(async () => {})
  expect(card()).toBeNull()
  expect(listPins).not.toHaveBeenCalled()
})

it('shows nothing in Minimal view', async () => {
  useUIStore.setState({ minimalView: true })
  mount()
  await act(async () => {})
  expect(card()).toBeNull()
})

it('shows nothing in the dashboard’s chat panel', async () => {
  mount(<ChatWorkspace chatId="chat-1" />)
  await act(async () => {})
  expect(card()).toBeNull()
  expect(listPins).not.toHaveBeenCalled()
})
