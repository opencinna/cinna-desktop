vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessagePart } from '../../../../shared/messageParts'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: data.messages } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))

const parts: MessagePart[] = [
  { kind: 'tool', toolId: 'one', toolName: 'Bash', toolInput: { command: 'cinna account agents --all' }, text: 'Bash: cinna account agents --all' },
  { kind: 'tool_result', toolId: 'one', toolStream: 'stdout', text: '```console\nAccessible agents (2)\n```' }
]

beforeEach(() => {
  data.messages = []
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('Cinna CLI transcript integration', () => {
  it('groups concurrent calls as pending/green/red dots without opening their content', () => {
    useUIStore.setState({ verboseMode: false })
    const first = { type: 'text' as const, ...parts[0], content: parts[0].text }
    const second = { ...first, toolId: 'two', content: '', toolInput: { command: 'cinna account status' } }
    useChatStore.setState({ streamingBlocks: [first, second], isStreaming: true })
    render(<MessageStream chatId="chat" />)
    expect(screen.getByRole('button', { name: 'Expand 2 steps' }).innerHTML).toContain('--color-warning')
    expect(screen.queryByRole('region')).toBeNull()
    act(() => useChatStore.setState({ streamingBlocks: [first, second,
      { type: 'text', kind: 'tool_result', toolId: 'two', content: 'Denied', toolStream: 'stderr' },
      { type: 'text', kind: 'tool_result', toolId: 'one', content: 'Connected', toolStream: 'stdout' }
    ], isStreaming: false }))
    const group = screen.getByRole('button', { name: 'Expand 2 steps' })
    expect(group.innerHTML).toContain('--color-success')
    expect(group.innerHTML).toContain('--color-danger')
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.click(group)
    expect(screen.getAllByRole('button', { name: /Cinna CLI/ })).toHaveLength(2)
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Cinna CLI cinna account status/ }))
    expect(screen.getByRole('region').textContent).toBe('Denied')
  })

  it.each([false, true])('renders one saved command/output block in verbose=%s', (verboseMode) => {
    useUIStore.setState({ verboseMode })
    data.messages = [{ id: 'message', role: 'assistant', content: '', parts }]
    render(<MessageStream chatId="chat" />)
    expect(screen.queryByRole('region')).toBeNull()
    if (!verboseMode) fireEvent.click(screen.getByRole('button', { name: /Expand 1 step/ }))
    fireEvent.click(screen.getByRole('button', { name: /Cinna CLI/ }))
    expect(screen.getAllByText('cinna account agents --all')).toHaveLength(1)
    expect(screen.getByRole('region').textContent).toBe('Accessible agents (2)')
    expect(screen.queryByText('Output')).toBeNull()
    expect(screen.queryByText('Tool:')).toBeNull()
  })

  it.each([false, true])('absorbs results arriving in the live stream in verbose=%s', (verboseMode) => {
    useUIStore.setState({ verboseMode })
    const blocks = parts.map(({ text, ...part }) => ({ type: 'text' as const, content: text, ...part }))
    useChatStore.setState({ streamingBlocks: blocks.slice(0, 1), isStreaming: true })
    render(<MessageStream chatId="chat" />)
    expect(screen.queryByText('Waiting for output…')).toBeNull()
    if (!verboseMode) fireEvent.click(screen.getByRole('button', { name: /Expand 1 step/ }))
    fireEvent.click(screen.getByRole('button', { name: /Cinna CLI/ }))
    expect(screen.getByText('Waiting for output…')).toBeTruthy()
    act(() => useChatStore.setState({ streamingBlocks: blocks }))
    expect(screen.getAllByText('Cinna CLI')).toHaveLength(1)
    expect(screen.getByRole('region').textContent).toBe('Accessible agents (2)')
    expect(screen.queryByText('Output')).toBeNull()
    act(() => useChatStore.setState({ isStreaming: false }))
    expect(screen.getByRole('region').textContent).toBe('Accessible agents (2)')
  })
})
