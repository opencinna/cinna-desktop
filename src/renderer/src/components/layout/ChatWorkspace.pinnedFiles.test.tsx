import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import { forwardRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Pinned files block in the chat workspace: on the main chat view, for a
 * chat whose root agent is a folder agent, and nowhere else; and the room the
 * transcript keeps for it, by the chat area's width.
 */

const spy = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => {} } } as never
  return {
    agents: [] as Array<{ id: string; capabilities: { cwd: boolean } }>,
    chat: null as null | { id: string; agentId: string | null },
    /** The chat area's laid-out width. */
    width: 1600,
    /** Every reserve the transcript was rendered with, in order. */
    reserves: [] as string[]
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
vi.mock('../chat/MessageStream', () => ({
  MessageStream: ({ reserve }: { reserve?: string | null }) => {
    if (spy.reserves.at(-1) !== (reserve ?? 'none')) spy.reserves.push(reserve ?? 'none')
    return <output data-testid="stream" data-reserve={reserve ?? 'none'} />
  }
}))
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
  spy.width = 1600
  spy.reserves = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ left: 0, top: 0, right: spy.width, bottom: 800, width: spy.width, height: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  )
  spy.agents = [{ id: 'folder:a', capabilities: { cwd: true } }, { id: 'remote:b', capabilities: { cwd: false } }]
  spy.chat = { id: 'chat-1', agentId: 'folder:a' }
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ activeView: 'chat', minimalView: false, pendingAgentId: null, pendingModeId: null, draftingAgentIds: [] })
  act(() => useChatStore.getState().setActiveChatId('chat-1'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mount(ui: React.ReactNode = <ChatWorkspace />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const card = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-pinned-files-card]')
const stream = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="stream"]')!

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

it('floats in a wide chat area’s gutter, and the transcript keeps no room', async () => {
  mount()
  await waitFor(() => expect(card()).not.toBeNull())
  expect(stream().dataset.reserve).toBe('none')
})

it('has the transcript keep a right-hand column for it where the gutter is too narrow', async () => {
  spy.width = 1100
  mount()
  await waitFor(() => expect(card()).not.toBeNull())
  await waitFor(() => expect(stream().dataset.reserve).toBe('right'))
  expect(card()!.className).toContain('absolute')
})

it('sits in its own band above the transcript in a chat area under 640 px', async () => {
  spy.width = 600
  mount()
  await waitFor(() => expect(card()).not.toBeNull())
  await waitFor(() => expect(stream().dataset.reserve).toBe('top'))
  // A flow sibling of the transcript, ordered before it in the chat area's column.
  expect(card()!.parentElement).toBe(stream().parentElement)
  expect(card()!.className).toContain('order-first')
  expect(card()!.className).not.toContain('absolute')
})

it('keeps no room while no block shows', async () => {
  spy.width = 1100
  listPins.mockResolvedValue({ success: true, pins: [] })
  mount()
  await waitFor(() => expect(listPins).toHaveBeenCalled())
  await act(async () => {})
  expect(card()).toBeNull()
  expect(stream().dataset.reserve).toBe('none')
})

it('keeps no room for a chat that shows no block, at any width', async () => {
  spy.width = 600
  spy.chat = { id: 'chat-1', agentId: 'remote:b' }
  mount()
  await act(async () => {})
  expect(card()).toBeNull()
  expect(stream().dataset.reserve).toBe('none')
})

describe('switching to a chat whose agent’s pins are not loaded yet', () => {
  const NOTES = { path: '/other/notes.md', displayPath: 'notes.md', inside: true, rank: 1, exists: true }

  async function switchToPending(): Promise<(pins: unknown[]) => Promise<void>> {
    spy.width = 1100
    spy.agents = [...spy.agents, { id: 'folder:c', capabilities: { cwd: true } }]
    mount()
    await waitFor(() => expect(stream().dataset.reserve).toBe('right'))
    let answer: (value: unknown) => void = () => {}
    listPins.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    spy.chat = { id: 'chat-2', agentId: 'folder:c' }
    act(() => useChatStore.getState().setActiveChatId('chat-2'))
    await waitFor(() => expect(listPins).toHaveBeenCalledWith({ agentId: 'folder:c' }))
    return async (pins) => { await act(async () => answer({ success: true, pins })) }
  }

  it('keeps the block and the transcript’s room until the new list is known', async () => {
    const resolve = await switchToPending()
    // Still there, inert: neither the block nor the column moves while it loads.
    expect(card()).not.toBeNull()
    expect(card()!.hasAttribute('inert')).toBe(true)
    expect(stream().dataset.reserve).toBe('right')
    await resolve([NOTES])
    await waitFor(() => expect(card()!.hasAttribute('inert')).toBe(false))
    expect(card()!.querySelector('[data-pinned-file="/other/notes.md"]')).not.toBeNull()
    expect(spy.reserves).toEqual(['none', 'right'])
  })

  it('gives the room back only once the new list is known to be empty', async () => {
    const resolve = await switchToPending()
    expect(stream().dataset.reserve).toBe('right')
    await resolve([])
    await waitFor(() => expect(card()).toBeNull())
    expect(spy.reserves).toEqual(['none', 'right', 'none'])
  })
})
