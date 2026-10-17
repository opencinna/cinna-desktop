import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => {
  const cards = vi.fn()
  const detail = vi.fn(async () => ({ ok: false, code: 'gone', message: 'gone' }))
  Object.assign(window, { api: { app: { setTheme: async () => {} }, agentFiles: { resolve: vi.fn(async () => ({ success: true, refs: [] })) }, artifacts: { cards, detail } } })
  return { cards, detail }
})

const data = vi.hoisted(() => ({ messages: [] as unknown[] }))
vi.mock('../../hooks/useChat', () => ({
  useChatDetail: () => ({ data: { messages: data.messages, agentId: 'folder:a' } })
}))
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
import { useArtifactsSupportStore } from '../../hooks/useArtifacts'
import { MessageStream } from './MessageStream'

/** An artifact card renders right after the message it was published from, and survives a reload (it is read back). */

const LIMITS = { maxRevisionBytes: 1, maxRevisionFiles: 1, maxFileBytes: 1 }
const card = (id: string, messageId: string, title: string) => ({
  id,
  chatId: 'chat',
  messageId,
  artifact: { id: `0f8fad5b-d9cb-469f-a165-70867728950${id.slice(-1)}`, title, kind: 'site', revision: 1, visibility: 'private', liveLinkCount: 0, url: 'u' }
})

function renderStream() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MessageStream chatId="chat" />
    </QueryClientProvider>
  )
}

/** Text of bubbles and cards in document order. */
function order(): string[] {
  return Array.from(document.querySelectorAll('[data-message-markdown], [data-artifact-card]')).map((node) =>
    node.hasAttribute('data-artifact-card') ? `card:${node.getAttribute('aria-label')}` : (node.getAttribute('data-message-markdown') ?? '')
  )
}

beforeEach(() => {
  data.messages = [
    { id: 'u1', role: 'user', content: 'Build the report', addressedAgentId: null },
    { id: 'a1', role: 'assistant', content: 'Wrote it', sourceAgentId: null },
    { id: 'u2', role: 'user', content: 'Thanks', addressedAgentId: null }
  ]
  api.cards.mockReset().mockResolvedValue([card('c1', 'a1', 'Q3 churn'), card('c2', 'u2', 'Notes'), card('c3', 'gone', 'Lost')])
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: true, instanceName: 'Acme', limits: LIMITS } })
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('artifact cards in the transcript', () => {
  it.each([false, true])('sit right after their message; a card whose message is gone is not drawn (verbose: %s)', async (verbose) => {
    useUIStore.setState({ verboseMode: verbose })
    renderStream()
    await screen.findByRole('group', { name: 'Artifact Q3 churn' })
    expect(order()).toEqual(['Build the report', 'Wrote it', 'card:Artifact Q3 churn', 'Thanks', 'card:Artifact Notes'])
    expect(api.cards).toHaveBeenCalledWith('chat')
  })

  it('keeps a link to an artifact the transcript already draws as a card, so it is not carded twice', async () => {
    const shownId = card('c1', 'a1', 'Q3 churn').artifact.id
    data.messages = [
      ...data.messages,
      { id: 'a2', role: 'assistant', content: `Published: [Q3 churn](https://core.example/artifact/${shownId})`, sourceAgentId: null }
    ]
    useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: true, instanceName: 'Acme', limits: LIMITS, linkOrigins: ['https://core.example'] } })
    // Core knows it: without the rule, the link would become a second card.
    api.detail.mockResolvedValue({ ok: true, detail: { ...card('c1', 'a1', 'Q3 churn').artifact, isOwner: true, ownerName: null, grantCount: 0, links: [] } } as never)
    renderStream()
    await screen.findByRole('group', { name: 'Artifact Q3 churn' })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(screen.getAllByRole('group', { name: 'Artifact Q3 churn' })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Q3 churn' }).getAttribute('href')).toBe(`https://core.example/artifact/${shownId}`)
  })

  it('reads and draws nothing while artifacts are unsupported', async () => {
    useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: false, limits: LIMITS } })
    renderStream()
    await act(async () => {})
    expect(api.cards).not.toHaveBeenCalled()
    expect(screen.queryByRole('group')).toBeNull()
  })
})
