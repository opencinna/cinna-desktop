import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

/**
 * The new-chat screen with one blank kit agent picked: the example prompts'
 * row is drawn empty, the composer offers the guidance (its notice row) and
 * says what to type, and a send asks main for a guided chat. Anything else is
 * the ordinary screen.
 */
const fixtures = vi.hoisted(() => {
  window.api = { app: { setTheme: async () => {} } } as never
  return {
    settings: { defaultMultiAgentRouting: 'human', guidedFirstBuild: true } as Record<string, unknown> | undefined,
    folder: { id: 'a1', kind: 'kit', unbuilt: true, name: 'Mail helper' } as Record<string, unknown> | null,
    /** The folder list cannot answer yet (loading, or refetching without the agent). */
    pending: false,
    startNewChat: vi.fn(async () => true)
  }
})
// Minimal view reads the chat's pending handoff from the query cache; no client here.
vi.mock('../tasks/PendingHandoffControl', () => ({ useChatHandoffPending: () => false }))
vi.mock('../../hooks/useAppSettings', () => ({ useAppSettings: () => ({ data: fixtures.settings }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [{ id: 'a1', name: 'Mail helper', skills: [] }, { id: 'a2', name: 'Other', skills: [] }] }) }))
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
vi.mock('../chat/ExamplePromptTags', () => ({ ExamplePromptTags: () => <p>Example prompts</p> }))
vi.mock('../chat/ComposerReadiness', () => ({
  RefusableExamplePrompts: ({ children }: { children: React.ReactNode }) => children,
  readinessRefusal: () => null,
  usePickedFolder: (id: string | null, listed: boolean) => {
    const folder = id && fixtures.folder?.id === id ? fixtures.folder : null
    return { folder, pending: id !== null && folder === null && fixtures.pending && !listed }
  }
}))
vi.mock('../chat/ChatInput', async () => {
  const { forwardRef, useImperativeHandle, useState } = await import('react')
  return {
    ChatInput: forwardRef(function ChatInput(props: {
      placeholder?: string
      guidedBuildAgentId?: string | null
      onNewChat?: (message: string) => unknown
      onTogglePendingAgent?: (id: string) => void
    }, ref) {
      const [filled, setFilled] = useState('')
      useImperativeHandle(ref, () => ({ focus: () => {}, clearInput: () => {}, fill: setFilled }))
      return <div>
        <output data-testid="guided-row">{props.guidedBuildAgentId ?? '(none)'}</output>
        <output data-testid="placeholder">{props.placeholder === undefined ? '(default)' : props.placeholder}</output>
        <output data-testid="filled">{filled}</output>
        <button onClick={() => void props.onNewChat?.('check my Gmail')}>Send</button>
        <button onClick={() => props.onTogglePendingAgent?.('a2')}>Toggle agent</button>
      </div>
    })
  }
})
const { ChatWorkspace } = await import('./ChatWorkspace')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useUIStore } = await import('../../stores/ui.store')

function mount(agentId = 'a1', embedded = true) {
  const client = new QueryClient()
  const tree = () => <QueryClientProvider client={client}><ChatWorkspace agentId={agentId} embedded={embedded} /></QueryClientProvider>
  const view = render(tree())
  return { ...view, rerender: () => view.rerender(tree()) }
}

beforeEach(() => {
  window.ResizeObserver = class { observe() {} disconnect() {} } as never
  fixtures.settings = { defaultMultiAgentRouting: 'human', guidedFirstBuild: true }
  fixtures.folder = { id: 'a1', kind: 'kit', unbuilt: true, name: 'Mail helper' }
  fixtures.pending = false
  fixtures.startNewChat.mockClear()
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ activeView: 'chat', pendingAgentId: null, pendingModeId: null, draftingAgentIds: [] })
})

it('hides the example prompts, offers the guidance in the composer, and asks for a guided chat', () => {
  mount()
  expect(screen.queryByText('Example prompts')).toBeNull()
  expect(screen.getByTestId('guided-build-slot')).toBeTruthy()
  // Mutation: keep the starters or the popover in the slot.
  expect(within(screen.getByTestId('new-chat-prompt-slot')).queryAllByRole('button')).toHaveLength(0)
  expect(screen.queryByText('What can agents do?')).toBeNull()
  expect(screen.getByTestId('guided-row').textContent).toBe('a1')
  expect(screen.getByTestId('placeholder').textContent).toBe('Describe what Mail helper should do for you…')
  fireEvent.click(screen.getByText('Send'))
  expect(fixtures.startNewChat).toHaveBeenCalledWith(expect.objectContaining({ agentIds: ['a1'], guidedBuild: true }))
})

it.each([
  ['the setting is off', () => { fixtures.settings = { defaultMultiAgentRouting: 'human', guidedFirstBuild: false } }],
  ['the agent is built', () => { fixtures.folder = { id: 'a1', kind: 'kit', unbuilt: false, name: 'Mail helper' } }],
  ['the agent is bare', () => { fixtures.folder = { id: 'a1', kind: 'bare', unbuilt: false, name: 'Mail helper' } }]
])('is the ordinary screen when %s, and a send asks for nothing', (_label, arrange) => {
  arrange()
  mount()
  expect(screen.queryByTestId('guided-build-slot')).toBeNull()
  expect(screen.getByTestId('guided-row').textContent).toBe('(none)')
  expect(screen.getByText('Example prompts')).toBeTruthy()
  expect(screen.getByTestId('placeholder').textContent).toBe('(default)')
  fireEvent.click(screen.getByText('Send'))
  expect(fixtures.startNewChat).toHaveBeenCalledWith(expect.not.objectContaining({ guidedBuild: true }))
})

it.each([
  ['the settings are not loaded yet', 'a1', () => { fixtures.settings = undefined }],
  ['the folder list cannot answer yet', 'folder:new', () => { fixtures.pending = true }]
])('is undetermined while %s — no prompts, no guidance row, a blank placeholder — then guided', (_label, agentId, arrange) => {
  // Mutation: fall back to the ordinary screen meanwhile, and the example
  // prompts and "Type a message..." paint first, then give way (rule 1).
  arrange()
  if (agentId !== 'a1') fixtures.folder = null
  const view = mount(agentId)
  expect(screen.queryByText('Example prompts')).toBeNull()
  expect(screen.getByTestId('guided-row').textContent).toBe('(none)')
  expect(screen.getByTestId('guided-build-undetermined')).toBeTruthy()
  expect(screen.getByTestId('placeholder').textContent).toBe('')
  fixtures.settings = { defaultMultiAgentRouting: 'human', guidedFirstBuild: true }
  fixtures.folder = { id: agentId, kind: 'kit', unbuilt: true, name: 'Mail helper' }
  fixtures.pending = false
  view.rerender()
  expect(screen.getByTestId('guided-row').textContent).toBe(agentId)
  expect(screen.getByTestId('guided-build-slot')).toBeTruthy()
  expect(screen.queryByTestId('guided-build-undetermined')).toBeNull()
})

it('is the ordinary screen at once for an agent the merged list has and the folder list does not, while it refetches', () => {
  fixtures.folder = null
  fixtures.pending = true
  mount('a2')
  expect(screen.getByText('Example prompts')).toBeTruthy()
  expect(screen.getByTestId('placeholder').textContent).toBe('(default)')
})

it('is the ordinary screen once a second agent is picked', () => {
  mount()
  fireEvent.click(screen.getByText('Toggle agent'))
  expect(screen.getByTestId('guided-row').textContent).toBe('(none)')
  fireEvent.click(screen.getByText('Send'))
  expect(fixtures.startNewChat).toHaveBeenCalledWith(expect.not.objectContaining({ guidedBuild: true }))
})

it('on the main New chat screen, asks its question in the generic heading’s own box, at the same margin', () => {
  const view = mount('a1', false)
  // Mutation: a second heading, a line under it, or a margin of its own, and
  // picking the agent by "@" or Skip guidance moves the composer.
  const headings = screen.getAllByRole('heading')
  expect(headings.map((h) => h.textContent)).toEqual(['What kind of agent will this be?'])
  expect(headings[0].tagName).toBe('H1')
  const box = headings[0].parentElement as HTMLElement
  expect(box.querySelector('p')).toBeNull()
  expect(box.className).toContain('mb-8')
  const boxClass = box.className
  // Skip guidance: the same box says the generic text again, nothing else changes.
  fixtures.folder = { id: 'a1', kind: 'kit', unbuilt: false, name: 'Mail helper' }
  view.rerender()
  const generic = screen.getByRole('heading', { name: 'What can I help with?' })
  expect(generic.parentElement).toBe(box)
  expect(box.className).toBe(boxClass)
})

it('on the embedded agent page, shows no heading at all', () => {
  mount()
  expect(screen.queryAllByRole('heading')).toHaveLength(0)
})

it('draws the guided and undetermined slots at the example-prompt row’s footprint, and reserves nothing', () => {
  // Mutation: give the empty slot a footprint of its own, and guided ↔
  // undetermined ↔ prompts moves the composer in the centered column.
  const view = mount()
  const guided = screen.getByTestId('guided-build-slot').className
  expect(guided.split(' ')).toEqual(expect.arrayContaining(['mb-3', 'min-h-10']))
  expect(screen.getByTestId('new-chat-prompt-slot').getAttribute('style')).toBeNull()
  fixtures.settings = undefined
  view.rerender()
  expect(screen.getByTestId('guided-build-undetermined').className).toBe(guided)
})
