import { act, render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

/**
 * "Set as Coordinator" on a pending chip of the new-chat screen: the draft is
 * coordinated with that agent conducting, the badge and chips say so, and
 * the send creates the chat with it as root (`useNewChatFlow`'s `conductorId`).
 */

const fixtures = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => {} } } as never
  return {
    agents: [
      { id: 'a1', name: 'First', skills: [], source: 'remote' },
      { id: 'a2', name: 'Second', skills: [], source: 'folder' }
    ],
    startNewChat: vi.fn(async () => true),
    props: { current: null as null | Record<string, unknown> }
  }
})
vi.mock('../../hooks/useAppSettings', () => ({ useAppSettings: () => ({ data: { defaultMultiAgentRouting: 'human' } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: fixtures.agents }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }), useDefaultChatMode: () => ({ data: null }) }))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useHintsEnabled', () => ({ useHintsEnabled: () => false }))
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: fixtures.startNewChat }), resolveModel: () => null }))
vi.mock('../../hooks/useApplyChatMode', () => ({ useApplyChatMode: () => vi.fn() }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: null }) }))
vi.mock('../chat/MessageStream', () => ({ MessageStream: () => null }))
vi.mock('../ui/HintBar', () => ({ HintBar: () => null }))
vi.mock('../chat/DesktopAppsBanner', () => ({ DesktopAppsBanner: () => null }))
vi.mock('../chat/ExamplePromptTags', () => ({ ExamplePromptTags: () => null }))
vi.mock('../chat/ComposerReadiness', () => ({ RefusableExamplePrompts: ({ children }: { children: React.ReactNode }) => children, readinessRefusal: () => null }))
vi.mock('../chat/ChatInput', () => ({ ChatInput: (props: Record<string, unknown>) => {
  fixtures.props.current = props
  return null
} }))
const { ChatWorkspace } = await import('./ChatWorkspace')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')

interface Info { router: string; conductorId: string | null; conductorName: string; coordinateAction?: { conductorName: string }; onSetCoordinator?: (id: string) => void }
const info = (): Info => fixtures.props.current?.routerInfo as Info

beforeEach(() => {
  window.ResizeObserver = class { observe() {} disconnect() {} } as never
  fixtures.startNewChat.mockClear()
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: { id: 'bob' } as never })
  useUIStore.setState({ activeView: 'chat', pendingAgentId: null, pendingModeId: null, draftingAgentIds: [] })
})

it('coordinates the draft with the agent set as coordinator, and creates the chat with it as root', async () => {
  render(<ChatWorkspace agentId="a1" embedded />)
  act(() => (fixtures.props.current?.onTogglePendingAgent as (id: string) => void)('a2'))
  expect(info().router).toBe('human')
  // The [+] item still targets the default conductor: the first agent, or the runtime.
  expect(info().coordinateAction?.conductorName).toBe('Default runtime')

  act(() => info().onSetCoordinator?.('a2'))
  expect(info()).toMatchObject({ router: 'coordinator', conductorId: 'a2', conductorName: 'Second' })
  expect(info().coordinateAction).toBeUndefined()

  await act(async () => { await (fixtures.props.current?.onNewChat as (m: string) => Promise<boolean>)('hi') })
  expect(fixtures.startNewChat).toHaveBeenCalledWith(expect.objectContaining({ agentIds: ['a1', 'a2'], coordinate: true, conductorId: 'a2' }))
  // The pick is spent with the send, like the coordinate flag and the agents.
  expect(info().router).toBe('direct')
  expect(fixtures.props.current?.pendingAgentIds).toEqual(['a1'])
  act(() => (fixtures.props.current?.onTogglePendingAgent as (id: string) => void)('a2'))
  expect(info()).toMatchObject({ router: 'human', conductorId: null })
})

it('drops a picked conductor once it is removed from the draft', () => {
  render(<ChatWorkspace agentId="a1" embedded />)
  act(() => (fixtures.props.current?.onTogglePendingAgent as (id: string) => void)('a2'))
  act(() => info().onSetCoordinator?.('a2'))
  act(() => (fixtures.props.current?.onRemovePendingAgent as (id: string) => void)('a2'))
  expect(info()).toMatchObject({ router: 'coordinator', conductorId: null, conductorName: 'Default runtime' })
})
