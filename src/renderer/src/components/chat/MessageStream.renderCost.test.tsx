vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../../../shared/messageParts'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

/**
 * What a streamed chunk costs the transcript: the saved messages' blocks must
 * not render again for it, and a closed group or sub-thread must not hold its
 * content at all until it is first opened.
 */

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
// Renders of each tool output block, by its content.
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('./ToolResultBlock', () => ({
  ToolResultBlock: ({ content }: { content: string }) => {
    renders.set(content, (renders.get(content) ?? 0) + 1)
    return <pre>{content}</pre>
  }
}))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: data.messages } }) }))
// One list, as TanStack Query keeps it between renders.
const agents = vi.hoisted(() => ({ data: [] }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => agents }))
// Stable, as the real hook's are between polls that change nothing.
const requests = vi.hoisted(() => ({ isPending: () => false, answerPermission: async () => ({}), answerQuestion: async () => ({}) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => requests }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

const savedTurn: MessagePart[] = [
  { kind: 'tool', toolId: 't1', toolName: 'Read', toolInput: { path: 'a.ts' }, text: 'Read a.ts' },
  { kind: 'tool_result', toolId: 't1', toolStream: 'stdout', text: 'saved output one' },
  { kind: 'text', text: 'Between the reads.' },
  { kind: 'tool_result', toolId: 't2', toolStream: 'stdout', text: 'saved output two' },
  { kind: 'text', text: 'Saved answer.' }
]

beforeEach(() => {
  data.messages = []
  renders.clear()
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({
    activeChatId: 'chat', streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null,
    inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null
  })
})

describe('a streamed chunk', () => {
  it.each([false, true])('does not render a saved message’s tool output again, verbose=%s', (verboseMode) => {
    // Mutation: build the saved nodes in render (no memo) → every chunk renders every saved block.
    useUIStore.setState({ verboseMode })
    data.messages = [
      { id: 'u1', role: 'user', content: 'Read the files' },
      { id: 'a1', role: 'assistant', content: 'Saved answer.', parts: savedTurn },
      { id: 'u2', role: 'user', content: 'Again' }
    ]
    useChatStore.setState({ isStreaming: true, liveBaselineMessageIds: ['u1', 'a1', 'u2'] })
    render(<MessageStream chatId="chat" />)
    // Compact draws a lone output as its own block; verbose draws both.
    const saved = verboseMode ? ['saved output one', 'saved output two'] : ['saved output two']
    const before = saved.map((content) => renders.get(content))
    expect(before.every((count) => count !== undefined && count > 0)).toBe(true)

    for (const chunk of ['Live ', 'answer ', 'grows.']) {
      act(() => useChatStore.getState().appendDelta(chunk))
    }
    expect(screen.getByText('Live answer grows.')).toBeTruthy()
    expect(saved.map((content) => renders.get(content))).toEqual(before)
  })

  it('draws the live turn’s steps into the saved turn’s trailing dots group, as before', () => {
    // The trailing run of saved dots is left ungrouped so live steps can join it.
    data.messages = [{ id: 'a1', role: 'assistant', content: '', parts: savedTurn.slice(0, 2) }]
    useChatStore.setState({
      isStreaming: true,
      streamingBlocks: [{ type: 'text', kind: 'tool_result', toolId: 't9', toolStream: 'stdout', content: 'live output' }]
    })
    render(<MessageStream chatId="chat" />)
    expect(screen.getAllByRole('button', { name: /^Expand \d+ steps?$/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Expand 3 steps'])
  })
})

describe('a closed dots group', () => {
  it('mounts its steps on the first open and keeps them mounted when closed again', () => {
    // Mutation: render the steps whatever `expanded` says → the output is rendered while closed.
    data.messages = [{ id: 'a1', role: 'assistant', content: '', parts: savedTurn.slice(0, 2) }]
    render(<MessageStream chatId="chat" />)
    const header = screen.getByRole('button', { name: 'Expand 2 steps' })
    expect(renders.get('saved output one')).toBeUndefined()
    expect(screen.queryByText('saved output one')).toBeNull()

    fireEvent.click(header)
    expect(screen.getByText('saved output one')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse 2 steps' }))
    // Still there, so the close animates; hidden by the group's 0fr row.
    expect(screen.getByText('saved output one')).toBeTruthy()
    const body = screen.getByRole('button', { name: 'Expand 2 steps' }).parentElement!.querySelector('.grid') as HTMLElement
    expect(body.style.gridTemplateRows).toBe('0fr')
  })
})

describe('a closed subagent thread', () => {
  const subagent: MessagePart[] = [
    { kind: 'tool', text: 'Agent: check pg', toolName: 'Agent', toolId: 'a1', toolInput: { description: 'check pg', prompt: 'Confirm pg' } },
    { kind: 'tool_result', text: 'inside the subagent', toolId: 'b1', toolStream: 'stdout', parentToolId: 'a1' },
    { kind: 'text', text: 'Subagent report.', parentToolId: 'a1' },
    { kind: 'tool_result', text: 'done', toolId: 'a1', toolStream: 'stdout' },
    { kind: 'text', text: 'Main answer.' }
  ]

  it('mounts its work on the first open and keeps it mounted when closed again', () => {
    // Mutation: drop the latch in AgentToolSubThread → the closed thread renders all its work.
    data.messages = [{ id: 'm', role: 'assistant', content: 'Main answer.', parts: subagent }]
    render(<MessageStream chatId="chat" />)
    const header = screen.getByRole('button', { name: /check pg/ })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Subagent report.')).toBeNull()
    expect(renders.get('inside the subagent')).toBeUndefined()

    fireEvent.click(header)
    expect(screen.getByText('Subagent report.')).toBeTruthy()
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('Subagent report.')).toBeTruthy()
  })
})
