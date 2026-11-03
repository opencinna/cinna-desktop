import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const agentState = vi.hoisted(() => ({ unbuilt: true }))
vi.hoisted(() => {
  Object.assign(window, { api: {
    app: { setTheme: async () => {} },
    agentFiles: { resolve: vi.fn(async () => ({ success: true, refs: [] })) },
    localAgents: { get: vi.fn(async () => ({ ok: true, value: { id: 'folder:a', kind: 'kit', unbuilt: agentState.unbuilt, runtime: null, stamps: {} } })) }
  } })
})

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
vi.mock('../../hooks/useChat', () => ({
  useChatDetail: () => ({ data: { messages: data.messages, agentId: 'folder:a' } })
}))
// Start building's own flow has its test (BuildBriefCard.test.tsx).
vi.mock('../../hooks/useNewChatFlow', () => ({ useNewChatFlow: () => ({ startNewChat: vi.fn() }) }))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [{ id: 'folder:a', name: 'A', capabilities: { cwd: true } }] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({
  useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} })
}))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
vi.mock('./QueuedMessages', () => ({
  QueuedMessages: () => null,
  useQueuedMessages: () => ({ chatId: 'chat', bubbles: [], holdsSent: false, handsOver: () => false, cancel: () => {} })
}))

import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import { MessageStream } from './MessageStream'
import { BUILD_BRIEF_PROVIDER_NAME, BUILD_BRIEF_RESULT, BUILD_BRIEF_TOOL } from '../../../../shared/buildBrief'

const brief = (summary: string) => ({ summary, prompt: `Build: ${summary}`, capabilities: [] })
const row = (id: string, summary: string, extra: Record<string, unknown> = {}) => ({
  id, role: 'tool_call', content: BUILD_BRIEF_RESULT, toolCallId: `tc-${id}`, toolName: BUILD_BRIEF_TOOL,
  toolProvider: BUILD_BRIEF_PROVIDER_NAME, toolInput: brief(summary), toolError: false, ...extra
})

function renderStream() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MessageStream chatId="chat" /></QueryClientProvider>)
}
const cards = () => screen.getAllByRole('group', { name: 'Build brief' })
const live = (card: HTMLElement) => within(card).queryByRole('button', { name: 'Start building' }) !== null

// The latest brief reads its agent before it shows controls.
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

beforeEach(() => {
  agentState.unbuilt = true
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('build brief cards in the transcript', () => {
  it('gives controls to the latest brief only, while nothing was said after it', async () => {
    data.messages = [
      { id: 'u1', role: 'user', content: 'check my Gmail', addressedAgentId: null },
      row('b1', 'First try'),
      { id: 'u2', role: 'user', content: 'Also Slack', addressedAgentId: null },
      row('b2', 'Revised')
    ]
    renderStream()
    await settle()
    const [first, second] = cards()
    expect(first.textContent).toContain('First try')
    expect(live(first)).toBe(false)
    expect(await within(second).findByRole('button', { name: 'Start building' })).toBeTruthy()
  })

  it('makes an answered brief read-only, and leaves a refused call to its plain row', async () => {
    data.messages = [
      row('b1', 'Answered'),
      { id: 'u2', role: 'user', content: 'Not quite', addressedAgentId: null },
      row('b2', 'Refused', { toolError: true, content: 'The brief was not shown: …' })
    ]
    renderStream()
    await settle()
    const all = cards()
    expect(all).toHaveLength(1)
    expect(live(all[0])).toBe(false)
  })

  it('draws a live brief, which is then the active one', async () => {
    data.messages = [row('b1', 'Persisted')]
    useChatStore.setState({ isStreaming: true, streamingBlocks: [
      { type: 'tool_call', id: 'tc-live', name: BUILD_BRIEF_TOOL, provider: BUILD_BRIEF_PROVIDER_NAME, providerType: 'mcp', input: brief('Live'), status: 'done' }
    ] as never })
    renderStream()
    await settle()
    const [persisted, streamed] = cards()
    expect(live(persisted)).toBe(false)
    expect(streamed.textContent).toContain('Live')
    expect(await within(streamed).findByRole('button', { name: 'Start building' })).toBeTruthy()
  })

  it('keeps the latest brief read-only once its agent is no longer unbuilt', async () => {
    // After Start building, Skip guidance, or a build this chat already did.
    agentState.unbuilt = false
    data.messages = [{ id: 'u1', role: 'user', content: 'check my Gmail', addressedAgentId: null }, row('b1', 'Latest')]
    renderStream()
    await settle()
    expect(live(cards()[0])).toBe(false)
  })
})
