import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => {} } } as never
  return {
    agents: [{ id: 'a1', name: 'First', skills: [] }, { id: 'a2', name: 'Second', skills: [] }],
    modes: [{ id: 'm1', name: 'Default', colorPreset: 'slate', mcpProviderIds: [] }, { id: 'm2', name: 'Chosen', colorPreset: 'rose', mcpProviderIds: [] }]
  }
})
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: fixtures.agents }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: fixtures.modes }), useDefaultChatMode: () => ({ data: fixtures.modes[0] }) }))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useHintsEnabled', () => ({ useHintsEnabled: () => false }))
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: vi.fn() }), resolveModel: () => null }))
vi.mock('../../hooks/useApplyChatMode', () => ({ useApplyChatMode: () => vi.fn() }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: null }) }))
vi.mock('../chat/MessageStream', () => ({ MessageStream: () => <p>Existing chat</p> }))
vi.mock('../ui/HintBar', () => ({ HintBar: () => null }))
vi.mock('../chat/ExamplePromptTags', () => ({ ExamplePromptTags: () => null }))
vi.mock('../chat/ComposerReadiness', () => ({ RefusableExamplePrompts: ({ children }: { children: React.ReactNode }) => children, readinessRefusal: () => null }))
vi.mock('../chat/ChatInput', () => ({ ChatInput: (props: {
  chatModeMenu?: { activeId: string; onSelectMode: (mode: unknown) => void }
  pendingAgentIds?: string[]; pendingMcpIds?: string[]
  onTogglePendingAgent?: (id: string) => void; onTogglePendingMcp?: (id: string) => void
}) => <div>
  <output data-testid="selections">{JSON.stringify({ mode: props.chatModeMenu?.activeId, agents: props.pendingAgentIds, mcps: props.pendingMcpIds })}</output>
  <button onClick={() => props.chatModeMenu?.onSelectMode(fixtures.modes[1])}>Choose mode</button>
  <button onClick={() => props.chatModeMenu?.onSelectMode(null)}>No mode</button>
  <button onClick={() => props.onTogglePendingAgent?.('a2')}>Toggle agent</button>
  <button onClick={() => props.onTogglePendingMcp?.('server')}>Toggle server</button>
</div> }))
const { ChatWorkspace } = await import('./ChatWorkspace')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')
beforeEach(() => {
  window.ResizeObserver = class { observe() {} disconnect() {} } as never
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ activeView: 'chat', pendingAgentId: null })
})
const selections = () => JSON.parse(screen.getByTestId('selections').textContent!)

it('keeps dashboard choices when visiting a chat and keeps each agent start page independent', () => {
  const first = render(<ChatWorkspace />)
  fireEvent.click(screen.getByText('Choose mode'))
  fireEvent.click(screen.getByText('Toggle agent'))
  fireEvent.click(screen.getByText('Toggle server'))
  act(() => useChatStore.getState().setActiveChatId('chat-1'))
  act(() => useChatStore.getState().setActiveChatId(null))
  expect(selections()).toEqual({ mode: 'm2', agents: ['a2'], mcps: ['server'] })
  first.unmount()
  const second = render(<ChatWorkspace agentId="a1" embedded />)
  expect(selections()).toEqual({ mode: 'm1', agents: ['a1'], mcps: [] })
  fireEvent.click(screen.getByText('No mode'))
  fireEvent.click(screen.getByText('Toggle agent'))
  second.unmount()
  const third = render(<ChatWorkspace agentId="a2" embedded />)
  expect(selections()).toEqual({ mode: 'm1', agents: ['a2'], mcps: [] })
  third.unmount()
  const fourth = render(<ChatWorkspace agentId="a1" embedded />)
  expect(selections()).toEqual({ mode: null, agents: ['a1', 'a2'], mcps: [] })
  fourth.unmount()
  render(<ChatWorkspace />)
  expect(selections()).toEqual({ mode: 'm2', agents: ['a2'], mcps: ['server'] })
})
