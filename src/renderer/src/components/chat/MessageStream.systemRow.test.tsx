vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

/**
 * A `system` row in the transcript.
 *
 * Two things write one — an autonomous task runner's prompt, and a file
 * handover's report returning to the chat that asked for the work — and until
 * this block existed both fell through to the stream's generic tail and were
 * drawn by `MessageBubble` with `role="assistant"`: a message nobody in the
 * conversation said, looking exactly like the agent saying it. So what is
 * pinned here is that it is *not* a bubble, that it is collapsed (the
 * interesting thing in the chat is what the agent did with it), and that its
 * header still says what arrived.
 */

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
vi.mock('../../hooks/useChat', () => ({ useChatDetail: () => ({ data: { messages: data.messages } }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./transcriptAnchor', () => ({ holdCollapseAnchor: () => () => {} }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

const REPORT = [
  '## Handover report — uploader retry',
  '',
  'Retry added with backoff; two tests cover the 5xx path.'
].join('\n')

beforeEach(() => {
  data.messages = []
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('a system row', () => {
  const header = (): HTMLElement =>
    screen.getByRole('button', { name: /^Cinna Desktop · Handover report — uploader retry$/ })

  it('is a collapsed block headed by its first line, not a message bubble', () => {
    data.messages = [{ id: 'm1', role: 'system', content: REPORT }]
    render(<MessageStream chatId="chat" />)
    // The heading marks are stripped: a header reading `## …` shows syntax.
    expect(header().getAttribute('aria-expanded')).toBe('false')
    // Collapsed means collapsed: the body is not in the document at all, so a
    // long report cannot push the composer down the moment it lands.
    expect(screen.queryByText(/two tests cover the 5xx path/)).toBeNull()
  })

  it('opens to the whole report when the header is clicked', () => {
    data.messages = [{ id: 'm1', role: 'system', content: REPORT }]
    render(<MessageStream chatId="chat" />)
    fireEvent.click(header())
    expect(header().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/two tests cover the 5xx path/)).toBeTruthy()
  })

  it('is not rendered as an assistant turn', () => {
    // The regression: before the explicit branch, this row reached the generic
    // tail and `MessageBubble` drew it as the agent's own answer. Mutation:
    // remove the branch in `MessageStream` and the report body is on screen
    // immediately, in an assistant bubble, with no disclosure button at all.
    data.messages = [{ id: 'm1', role: 'system', content: REPORT }]
    const { container } = render(<MessageStream chatId="chat" />)
    expect(container.querySelector('[data-message-role="assistant"]')).toBeNull()
    expect(screen.queryByText(/Retry added with backoff/)).toBeNull()
  })

  it('renders one block per system row, beside the ordinary turns', () => {
    data.messages = [
      { id: 'm1', role: 'user', content: 'hand this to the uploader' },
      { id: 'm2', role: 'system', content: REPORT },
      { id: 'm3', role: 'assistant', content: 'The uploader reported back.' }
    ]
    render(<MessageStream chatId="chat" />)
    expect(screen.getByText('hand this to the uploader')).toBeTruthy()
    expect(screen.getByText('The uploader reported back.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Cinna Desktop · / })).toHaveLength(1)
  })
})
