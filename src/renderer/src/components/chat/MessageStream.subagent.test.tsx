vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../../../shared/messageParts'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

const data = vi.hoisted(() => ({ messages: [] as unknown[], pending: [] as string[] }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: data.messages } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: (id: string) => data.pending.includes(id), answerPermission: async () => {}, answerQuestion: async () => {} }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

// The persisted shape of the real session, after the fix: the parent's
// paragraph whole, the subagent's work in its lane.
const parts: MessagePart[] = [
  { kind: 'tool', text: 'Agent: check pg', toolName: 'Agent', toolId: 'a1', toolInput: { description: 'check pg', prompt: 'Confirm pg' } },
  { kind: 'text', text: 'the Florian Rockenhäuser / Traffective metric' },
  { kind: 'tool', text: 'Bash: psql -c 1', toolName: 'Bash', toolId: 'b1', toolInput: { command: 'psql -c 1' }, parentToolId: 'a1' },
  { kind: 'tool_result', text: 'one row', toolId: 'b1', toolStream: 'stdout', parentToolId: 'a1' },
  { kind: 'text', text: 'Confirmed pg for the subagent.', parentToolId: 'a1' }
]

beforeEach(() => {
  data.messages = []
  data.pending = []
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

function expectNested(): void {
  const thread = screen.getByText('check pg').closest('.text-xs') as HTMLElement
  expect(thread.textContent).toContain('Confirmed pg for the subagent.')
  expect(thread.textContent).not.toContain('Traffective')
  expect(screen.getByText('the Florian Rockenhäuser / Traffective metric')).toBeTruthy()
  expect(screen.getAllByText('Confirmed pg for the subagent.')).toHaveLength(1)
}

describe('a Claude subagent’s work in the transcript', () => {
  it.each([false, true])('nests saved subagent parts under the Agent call in verbose=%s', (verboseMode) => {
    useUIStore.setState({ verboseMode })
    data.messages = [{ id: 'message', role: 'assistant', content: 'the Florian Rockenhäuser / Traffective metric', parts }]
    render(<MessageStream chatId="chat" />)
    expectNested()
  })

  it.each([false, true])('nests live subagent blocks under the Agent call in verbose=%s', (verboseMode) => {
    useUIStore.setState({ verboseMode })
    const blocks = parts.map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part }))
    useChatStore.setState({ streamingBlocks: blocks, isStreaming: true })
    render(<MessageStream chatId="chat" />)
    expectNested()
  })
})

describe('the Agent call’s row, live and saved', () => {
  it.each([false, true])('is the sub-thread from the call’s first frame, and stays one after the turn is saved, verbose=%s', (verboseMode) => {
    // Mutation: no live group for a call with no subagent parts → a "Tool: Agent" narration row first.
    useUIStore.setState({ verboseMode })
    useChatStore.setState({ streamingBlocks: [{ type: 'text', kind: 'tool', content: 'Agent: check pg', toolName: 'Agent', toolId: 'a1', toolInput: parts[0].toolInput }], isStreaming: true })
    const view = render(<MessageStream chatId="chat" />)
    expect(screen.getByTestId('agent-ask').textContent).toBe('Confirm pg')
    expect(screen.getByText('Working…')).toBeTruthy()
    expect(screen.getByRole('button', { name: /check pg/ })).toBeTruthy()
    expect(screen.queryByText('Agent: check pg')).toBeNull()
    // The subagent speaks, then the turn is saved: the same control throughout.
    useChatStore.setState({ streamingBlocks: parts.map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part })) })
    view.rerender(<MessageStream chatId="chat" />)
    expect(screen.getByRole('button', { name: /check pg/ })).toBeTruthy()
    data.messages = [{ id: 'message', role: 'assistant', content: 'the Florian Rockenhäuser / Traffective metric', parts }]
    useChatStore.setState({ streamingBlocks: [], isStreaming: false })
    view.rerender(<MessageStream chatId="chat" />)
    expect(screen.getByRole('button', { name: /check pg/ })).toBeTruthy()
    expect(screen.queryByText('Agent: check pg')).toBeNull()
  })
})

describe('a subagent’s permission ask', () => {
  const ask: MessagePart = {
    kind: 'tool', text: 'Permission requested', toolName: 'cinna_permission_request', toolId: 'per_child',
    toolInput: { action: 'bash', resources: ['psql -c 1'], savable: [] }, parentToolId: 'a1'
  }
  const liveBlocks = (extra: MessagePart[]) =>
    [...parts.slice(0, 3), ...extra].map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part }))
  const body = (): HTMLElement => screen.getByText('check pg').closest('.text-xs')!.querySelector('.grid') as HTMLElement

  it('renders answerable inside the sub-thread, and holds it open while pending', () => {
    // Mutation: drop `renderRequest` from `renderSubagentGroup` → no Allow button; drop `holdOpen` → the collapse closes it.
    useUIStore.setState({ verboseMode: false })
    data.pending = ['per_child']
    useChatStore.setState({ streamingBlocks: liveBlocks([ask]), isStreaming: true })
    render(<MessageStream chatId="chat" />)
    const thread = screen.getByText('check pg').closest('.text-xs') as HTMLElement
    const allow = screen.getByRole('button', { name: 'Allow once' })
    expect(thread.contains(allow)).toBe(true)
    expect((allow as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('check pg'))
    expect(body().style.gridTemplateRows).toBe('1fr')
  })

  it('lets the thread close once the ask is no longer pending', () => {
    useUIStore.setState({ verboseMode: false })
    useChatStore.setState({ streamingBlocks: liveBlocks([ask]), isStreaming: true })
    render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getByText('check pg'))
    expect(body().style.gridTemplateRows).toBe('0fr')
  })
})

describe('an Agent call whose subagent failed before it said anything', () => {
  const failed: MessagePart[] = [
    parts[0],
    { kind: 'tool_result', text: 'Subagent crashed.', toolId: 'a1', toolStream: 'stderr' },
    { kind: 'text', text: 'It failed, carrying on.' }
  ]
  it.each([false, true])('is the same failed sub-thread live and saved, verbose=%s', (verboseMode) => {
    // Mutation: saved call with no lane parts → a plain tool row, its error a loose dot.
    useUIStore.setState({ verboseMode })
    useChatStore.setState({ streamingBlocks: failed.map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part })), isStreaming: true })
    const view = render(<MessageStream chatId="chat" />)
    const header = (): HTMLElement => screen.getByRole('button', { name: /check pg/ })
    expect(header().textContent).toContain('error')
    expect(screen.getByText('Subagent crashed.')).toBeTruthy()
    data.messages = [{ id: 'message', role: 'assistant', content: 'It failed, carrying on.', parts: failed }]
    useChatStore.setState({ streamingBlocks: [], isStreaming: false })
    view.rerender(<MessageStream chatId="chat" />)
    expect(header().textContent).toContain('error')
    expect(screen.getByText('Subagent crashed.')).toBeTruthy()
    expect(screen.queryByText('Agent: check pg')).toBeNull()
  })
})

describe('the streaming cursor while a subagent speaks', () => {
  it('is not on the agent’s own last words when a nested block streams last', () => {
    // Mutation: "last" counted over visible blocks only → the parent's paragraph keeps the cursor.
    useUIStore.setState({ verboseMode: true })
    useChatStore.setState({ streamingBlocks: parts.map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part })), isStreaming: true })
    render(<MessageStream chatId="chat" />)
    const own = document.querySelector('[data-message-markdown="the Florian Rockenhäuser / Traffective metric"]') as HTMLElement
    expect(own).toBeTruthy()
    expect(own.querySelector('.animate-pulse')).toBeNull()
  })

  it('is on the agent’s own words when they are the last block', () => {
    useUIStore.setState({ verboseMode: true })
    const blocks = [...parts, { kind: 'text', text: 'And now mine.' } as MessagePart]
    useChatStore.setState({ streamingBlocks: blocks.map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part })), isStreaming: true })
    render(<MessageStream chatId="chat" />)
    const own = document.querySelector('[data-message-markdown="the Florian Rockenhäuser / Traffective metricAnd now mine."], [data-message-markdown="And now mine."]') as HTMLElement
    expect(own.querySelector('.animate-pulse')).toBeTruthy()
  })
})

describe('a steer while a subagent works', () => {
  it('renders the live turn as the saved rows will', () => {
    // Mutation: one segment → the lane is one group above the steer, carrying the error.
    useUIStore.setState({ verboseMode: true })
    const before: MessagePart[] = [parts[0], parts[2], parts[4]]
    const after: MessagePart[] = [
      { kind: 'text', text: 'Now mysql.', parentToolId: 'a1' },
      { kind: 'tool_result', text: 'Subagent failed.', toolId: 'a1', toolStream: 'stderr' }
    ]
    const asBlocks = (list: MessagePart[]) => list.map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part }))
    useChatStore.setState({ streamingBlocks: [...asBlocks(before), { type: 'user', content: 'also check mysql' }, ...asBlocks(after)], isStreaming: true })
    const view = render(<MessageStream chatId="chat" />)
    const headers = (): string[] => screen.getAllByRole('button', { name: /check pg|Subagent/ }).map((b) => b.textContent ?? '')
    const live = headers()
    expect(live).toHaveLength(2)
    expect(live[0]).toContain('done')
    expect(live[1]).toContain('Subagent')
    expect(live[1]).toContain('error')
    data.messages = [
      { id: 'm1', role: 'assistant', content: '', parts: before },
      { id: 'u1', role: 'user', content: 'also check mysql' },
      { id: 'm2', role: 'assistant', content: '', parts: after }
    ]
    useChatStore.setState({ streamingBlocks: [], isStreaming: false })
    view.rerender(<MessageStream chatId="chat" />)
    expect(headers()).toEqual(live)
  })
})

describe('a delegated agent’s own subagent', () => {
  const sub: MessagePart[] = [
    { kind: 'text', text: 'Delegating.' },
    ...parts.filter((part) => part.kind !== 'text' || part.parentToolId)
  ]
  it('nests inside the specialist’s saved thread', () => {
    // Mutation: pass `msg.parts` flat → the child's report reads as the specialist's own.
    useUIStore.setState({ verboseMode: true })
    data.messages = [{ id: 'tc', role: 'tool_call', content: 'ok', toolName: 'ask_specialist', toolProvider: 'Researcher', toolInput: { message: 'look' }, parts: sub }]
    render(<MessageStream chatId="chat" />)
    const inner = screen.getByRole('button', { name: /check pg/ }).closest('.text-xs') as HTMLElement
    expect(inner.textContent).toContain('Confirmed pg for the subagent.')
    expect(screen.getAllByText('Confirmed pg for the subagent.')).toHaveLength(1)
  })

  it('nests inside the specialist’s live thread', () => {
    useUIStore.setState({ verboseMode: true })
    useChatStore.setState({ isStreaming: true, streamingBlocks: [{ type: 'tool_call', id: 'tc', name: 'ask_specialist', provider: 'Researcher', input: { message: 'look' }, status: 'pending', providerType: 'agent', subParts: sub }] })
    render(<MessageStream chatId="chat" />)
    const inner = screen.getByRole('button', { name: /check pg/ }).closest('.text-xs') as HTMLElement
    expect(inner.textContent).toContain('Confirmed pg for the subagent.')
    expect(inner.textContent).not.toContain('Delegating.')
    expect(screen.getAllByText('Confirmed pg for the subagent.')).toHaveLength(1)
  })
})
