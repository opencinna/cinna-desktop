vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} }, system: { openExternal: async () => ({ success: true }) } } }) })
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { MessageStream } from './MessageStream'

/**
 * A saved `agent_transition` row whose `parts` mark it a warning stays an
 * expanded warning row in compact mode; a row without that part (every row
 * from before the tone) is the info dot it always was.
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

const WARNING = 'Gemini answered an error (503): The model is currently unreachable.'

beforeEach(() => {
  data.messages = []
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('a saved notice row in compact mode', () => {
  it('shows a warning row expanded, and an old info row as the dot', () => {
    // Mutation: drop the `tone` read in MessageStream → both rows are dots.
    data.messages = [
      { id: 'u1', role: 'user', content: 'hi', parts: null },
      { id: 'n1', role: 'agent_transition', content: 'Starting up', parts: null },
      { id: 'n2', role: 'agent_transition', content: WARNING, parts: [{ kind: 'notice', text: WARNING, tone: 'warning' }] }
    ]
    const { container } = render(<MessageStream chatId="chat" />)
    const warnings = container.querySelectorAll('[data-notice-tone="warning"]')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].textContent).toBe(WARNING)
    expect(screen.getAllByRole('button', { name: 'Show agent notice' })).toHaveLength(1)
    expect(screen.queryByText('Starting up')).toBeNull()
  })
})
