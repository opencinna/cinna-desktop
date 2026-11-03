import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    props: { current: null as null | Record<string, unknown> },
    defaultRouting: 'human' as 'human' | 'coordinator'
  }
})
vi.mock('../../hooks/useAppSettings', () => ({ useAppSettings: () => ({ data: { defaultMultiAgentRouting: fixtures.defaultRouting } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: fixtures.agents }) }))
vi.mock('../../hooks/useChatModes', () => ({ useChatModes: () => ({ data: [] }), useDefaultChatMode: () => ({ data: null }) }))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useHintsEnabled', () => ({ useHintsEnabled: () => false }))
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: fixtures.startNewChat }), resolveModel: () => null }))
vi.mock('../../hooks/useApplyChatMode', () => ({ useApplyChatMode: () => vi.fn() }))
vi.mock('../../hooks/useNewChatLike', () => ({ useNewChatLike: () => vi.fn(async () => undefined) }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: null }) }))
vi.mock('../chat/MessageStream', () => ({ MessageStream: () => null }))
vi.mock('../ui/HintBar', () => ({ HintBar: () => null }))
vi.mock('../chat/DesktopAppsBanner', () => ({ DesktopAppsBanner: () => null }))
vi.mock('../chat/ExamplePromptTags', () => ({ ExamplePromptTags: () => null }))
vi.mock('../chat/ComposerReadiness', () => ({ RefusableExamplePrompts: ({ children }: { children: React.ReactNode }) => children, readinessRefusal: () => null, usePickedFolder: () => ({ folder: null, pending: false }) }))
vi.mock('../chat/ChatInput', () => ({ ChatInput: (props: Record<string, unknown>) => {
  fixtures.props.current = props
  return null
} }))
const { ChatWorkspace } = await import('./ChatWorkspace')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')
const { useComposerDraftStore, composerDraftKey } = await import('../../stores/composerDraft.store')
const { chatDraftRouting } = await vi.importActual<typeof import('../../hooks/useNewChatLike')>('../../hooks/useNewChatLike')

interface Info { router: string; conductorId: string | null; conductorName: string; coordinateAction?: { conductorName: string }; onSetCoordinator?: (id: string) => void }
const info = (): Info => fixtures.props.current?.routerInfo as Info

beforeEach(() => {
  window.ResizeObserver = class { observe() {} disconnect() {} } as never
  fixtures.startNewChat.mockClear()
  fixtures.defaultRouting = 'human'
  useComposerDraftStore.setState({ drafts: {} })
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

it('offers no coordination to a lone local agent, which would coordinate nobody', () => {
  render(<ChatWorkspace agentId="a2" embedded />)
  expect(info().coordinateAction).toBeUndefined()
  expect(info().onSetCoordinator).toBeUndefined()
})

it('offers Coordinate by… but no Set as Coordinator to a lone remote agent', () => {
  render(<ChatWorkspace agentId="a1" embedded />)
  // The Default runtime would coordinate it.
  expect(info().coordinateAction?.conductorName).toBe('Default runtime')
  expect(info().onSetCoordinator).toBeUndefined()
})

it('starts over when the draft is left with nothing to coordinate', () => {
  render(<ChatWorkspace agentId="a2" embedded />)
  act(() => (fixtures.props.current?.onTogglePendingAgent as (id: string) => void)('a1'))
  act(() => info().onSetCoordinator?.('a2'))
  expect(info()).toMatchObject({ router: 'coordinator', conductorId: 'a2' })
  act(() => (fixtures.props.current?.onRemovePendingAgent as (id: string) => void)('a1'))
  // Only the coordinator is left: no hidden one-way flag survives.
  expect(info().router).toBe('direct')
  // Bringing a1 back is not coordinated behind the user's back.
  act(() => (fixtures.props.current?.onTogglePendingAgent as (id: string) => void)('a1'))
  expect(info()).toMatchObject({ router: 'human' })
})

describe('New chat from a human-routed chat, with coordinator as the Settings default', () => {
  const draftKey = composerDraftKey('bob', 'agent:a1')
  const setUpLikeHumanChat = (): void => {
    fixtures.defaultRouting = 'coordinator'
    const routing = chatDraftRouting({ agentId: null, router: 'human', modeId: null }, fixtures.agents, ['a1', 'a2'], [])
    useComposerDraftStore.getState().update(draftKey, () => routing)
  }

  it('creates a human chat, and the next draft goes back to the default', async () => {
    setUpLikeHumanChat()
    render(<ChatWorkspace agentId="a1" embedded />)
    expect(info().router).toBe('human')
    await act(async () => { await (fixtures.props.current?.onNewChat as (m: string) => Promise<boolean>)('hi') })
    expect(fixtures.startNewChat).toHaveBeenCalledWith(expect.objectContaining({ agentIds: ['a1', 'a2'], coordinate: false, defaultMultiAgentRouting: 'human' }))
    expect(useComposerDraftStore.getState().drafts[draftKey]?.multiAgentRouting).toBeNull()
    act(() => (fixtures.props.current?.onTogglePendingAgent as (id: string) => void)('a2'))
    expect(info().router).toBe('coordinator')
  })

  it('an edit of the agent set gives the routing back to the default', () => {
    setUpLikeHumanChat()
    render(<ChatWorkspace agentId="a1" embedded />)
    act(() => (fixtures.props.current?.onRemovePendingAgent as (id: string) => void)('a2'))
    act(() => (fixtures.props.current?.onTogglePendingAgent as (id: string) => void)('a2'))
    expect(info().router).toBe('coordinator')
  })
})
