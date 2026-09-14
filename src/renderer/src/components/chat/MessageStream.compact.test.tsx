vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../../../shared/messageParts'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { AgentContribution } from './AgentContribution'
import { MessageStream } from './MessageStream'

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
const stick = vi.hoisted(() => ({ pinned: true }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: data.messages } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: stick.pinned, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
const anchor = vi.hoisted(() => ({ holdCollapseAnchor: vi.fn((_container: HTMLElement, _content: HTMLElement): (() => void) | null => () => {}) }))
vi.mock('./transcriptAnchor', () => anchor)
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

/** Tool, result, thinking, tool, result — a turn that used to read as five dots. */
const turn: MessagePart[] = [
  { kind: 'tool', toolId: 't1', toolName: 'Read', toolInput: { path: 'a.ts' }, text: 'Read a.ts' },
  { kind: 'tool_result', toolId: 't1', toolStream: 'stdout', text: 'contents of a' },
  { kind: 'thinking', text: 'Now compare it with b' },
  { kind: 'tool', toolId: 't2', toolName: 'Read', toolInput: { path: 'b.ts' }, text: 'Read b.ts' },
  { kind: 'tool_result', toolId: 't2', toolStream: 'stdout', text: 'contents of b' }
]

/** The visible, top-level disclosure buttons in document order, by accessible name. */
function outline(): string[] {
  return screen
    .getAllByRole('button', { name: /^(Expand|Collapse) \d+ steps?$|^Thinking$/ })
    .map((b) => `${b.getAttribute('aria-label') ?? b.textContent}:${b.getAttribute('aria-expanded')}`)
}

beforeEach(() => {
  data.messages = []
  stick.pinned = true
  anchor.holdCollapseAnchor.mockClear()
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('compact transcript: thinking breaks the dots', () => {
  it('persisted: two dot groups with an open thinking block between them', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: turn }]
    render(<MessageStream chatId="chat" />)
    expect(outline()).toEqual(['Expand 2 steps:false', 'Thinking:true', 'Expand 2 steps:false'])
    expect(screen.getByText('Now compare it with b')).toBeTruthy()
  })

  it('live stream: the same shape while the turn is running', () => {
    useChatStore.setState({
      isStreaming: true,
      streamingBlocks: turn.map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part }))
    })
    render(<MessageStream chatId="chat" />)
    expect(outline()).toEqual(['Expand 2 steps:false', 'Thinking:true', 'Expand 2 steps:false'])
  })

  it('nested agent sub-thread: the same shape', () => {
    render(<AgentContribution parts={turn} />)
    expect(outline()).toEqual(['Expand 2 steps:false', 'Thinking:true', 'Expand 2 steps:false'])
  })

  it('verbose mode: every block inline, thinking open as in compact mode', () => {
    useUIStore.setState({ verboseMode: true })
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: turn }]
    render(<MessageStream chatId="chat" />)
    expect(outline()).toEqual(['Thinking:true'])
    expect(screen.queryByRole('button', { name: /steps?$/ })).toBeNull()
  })
})

describe('Collapse expanded', () => {
  const collapsePill = (): HTMLElement | null => screen.queryByRole('button', { name: 'Collapse expanded' })

  it('appears when the user opens a group and collapses it again', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: turn }]
    render(<MessageStream chatId="chat" />)
    expect(collapsePill()).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 2 steps' })[1])
    expect(outline()).toEqual(['Expand 2 steps:false', 'Thinking:true', 'Collapse 2 steps:true'])
    fireEvent.click(collapsePill()!)
    expect(outline()).toEqual(['Expand 2 steps:false', 'Thinking:true', 'Expand 2 steps:false'])
    expect(collapsePill()).toBeNull()
  })

  it('collapses blocks the user opened inside a group, and leaves default-open thinking open', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: turn }]
    render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 2 steps' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))
    expect(screen.getByText('contents of a')).toBeTruthy()
    fireEvent.click(collapsePill()!)
    expect(screen.queryByText('contents of a')).toBeNull()
    expect(outline()).toEqual(['Expand 2 steps:false', 'Thinking:true', 'Expand 2 steps:false'])
  })

  it('goes away when the only block the user opened sits in a group they then closed', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: turn }]
    render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 2 steps' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))
    expect(collapsePill()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse 2 steps' }))
    expect(collapsePill()).toBeNull()
  })

  it('does not appear for a default-expanded thinking block, opened or closed by the user', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: [{ kind: 'thinking', text: 'Hmm' }] }]
    render(<MessageStream chatId="chat" />)
    expect(outline()).toEqual(['Thinking:true'])
    expect(collapsePill()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(collapsePill()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(collapsePill()).toBeNull()
  })

  it('does not count a live tool result that opened because it streams', () => {
    useChatStore.setState({
      isStreaming: true,
      streamingBlocks: [
        { type: 'text', kind: 'tool', toolId: 't1', toolName: 'Read', content: 'Read a.ts' },
        { type: 'text', kind: 'tool_result', toolId: 't1', toolStream: 'stdout', content: 'out' }
      ]
    })
    render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand 2 steps' }))
    expect(screen.getByText('out')).toBeTruthy()
    // The group was the user's; the result inside it opened by default, so
    // collapsing closes the group and leaves the result open inside it.
    fireEvent.click(collapsePill()!)
    expect(collapsePill()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand 2 steps' }))
    expect(screen.getByText('out')).toBeTruthy()
    expect(collapsePill()).not.toBeNull()
  })

  it('sits left of Jump to latest when both show, and neither moves when the other goes', () => {
    stick.pinned = false
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: turn }]
    const { rerender } = render(<MessageStream chatId="chat" />)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()
    expect(collapsePill()).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 2 steps' })[0])
    const pills = screen.getAllByRole('button', { name: /^(Collapse expanded|Jump to latest)$/ })
    expect(pills.map((p) => p.textContent)).toEqual(['Collapse expanded', 'Jump to latest'])
    expect(pills.every((p) => !p.hasAttribute('aria-label'))).toBe(true)
    const collapseColumn = pills[0].parentElement
    const jump = pills[1]
    // Jumping re-pins and hides its pill; the collapse pill keeps its column
    // and the hidden pill keeps its slot, so nothing slides under the pointer.
    stick.pinned = true
    rerender(<MessageStream chatId="chat" />)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    expect(collapsePill()!.parentElement).toBe(collapseColumn)
    expect(jump.isConnected).toBe(true)
    expect(jump.getAttribute('aria-hidden')).toBe('true')
  })

  it('holds what the reader is looking at through the collapse, only when the view is not following the bottom', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: turn }]
    const { rerender } = render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 2 steps' })[0])
    // Pinned: the stick model keeps the bottom, nothing to hold.
    fireEvent.click(collapsePill()!)
    expect(anchor.holdCollapseAnchor).not.toHaveBeenCalled()

    stick.pinned = false
    rerender(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 2 steps' })[0])
    fireEvent.click(collapsePill()!)
    // The scroll area and its content box; where a group header lands is
    // `transcriptAnchor.test.ts`'s to prove.
    expect(anchor.holdCollapseAnchor).toHaveBeenCalledTimes(1)
    expect(anchor.holdCollapseAnchor).toHaveBeenCalledWith(expect.any(HTMLElement), expect.any(HTMLElement))
    expect(collapsePill()).toBeNull()
  })

  it('starts empty for another chat', () => {
    data.messages = [{ id: 'm', role: 'assistant', content: '', parts: turn }]
    const { rerender } = render(<MessageStream chatId="chat" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand 2 steps' })[0])
    expect(collapsePill()).not.toBeNull()
    act(() => { data.messages = [{ id: 'other', role: 'assistant', content: '', parts: turn }] })
    rerender(<MessageStream chatId="other-chat" />)
    expect(collapsePill()).toBeNull()
  })
})
