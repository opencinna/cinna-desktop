import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => {
  const resolve = vi.fn()
  Object.assign(window, { api: { app: { setTheme: async () => {} }, agentFiles: { resolve } } })
  return { resolve }
})

const data = vi.hoisted(() => ({
  messages: [] as unknown[],
  agents: [
    { id: 'folder:a', name: 'A', capabilities: { cwd: true } },
    { id: 'folder:b', name: 'B', capabilities: { cwd: true } },
    { id: 'remote:r', name: 'R', capabilities: { cwd: false } }
  ]
}))
vi.mock('../../hooks/useChat', () => ({
  useChatDetail: () => ({ data: { messages: data.messages, agentId: 'folder:a' } })
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: data.agents }) }))
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
import { MessageStream } from './MessageStream'

/**
 * Which agent's references a bubble is linked against: the root agent unless
 * the row names another — `addressedAgentId` on a user row, `sourceAgentId` on
 * an assistant row — and only for agents that run in a folder.
 */

function renderStream(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MessageStream chatId="chat" />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  // Every `.csv` span resolves, for whichever agent is asked.
  api.resolve.mockReset()
  api.resolve.mockImplementation(async ({ agentId, candidates }: { agentId: string; candidates: string[] }) => ({
    success: true,
    refs: candidates
      .filter((c) => c.endsWith('.csv'))
      .map((c) => ({ text: c, path: `/${agentId}/${c}`, displayPath: c, kind: 'file', inside: true }))
  }))
  data.messages = [
    { id: 'u1', role: 'user', content: 'Look at `in/a.csv`', addressedAgentId: null },
    { id: 'a1', role: 'assistant', content: 'Wrote `out/b.csv`', sourceAgentId: null },
    { id: 'u2', role: 'user', content: 'B, check `b/u.csv`', addressedAgentId: 'folder:b' },
    { id: 'a2', role: 'assistant', content: '', sourceAgentId: 'folder:b', parts: [{ kind: 'text', text: 'B wrote `b/c.csv`' }] },
    { id: 'u3', role: 'user', content: 'R, see `r.csv`', addressedAgentId: 'remote:r' },
    { id: 'a3', role: 'assistant', content: 'R: `r2.csv`', sourceAgentId: 'remote:r' }
  ]
  useUIStore.setState({ verboseMode: false })
  useChatStore.setState({ streamingBlocks: [], isStreaming: false, liveBaselineMessageIds: null, inputRequests: [], settledInputRequestIds: [], pendingUserMessage: null })
})

describe('file references in the transcript', () => {
  it.each([false, true])('link each bubble against its own folder agent (verbose: %s)', async (verbose) => {
    useUIStore.setState({ verboseMode: verbose })
    renderStream()
    for (const name of ['in/a.csv', 'out/b.csv', 'b/u.csv', 'b/c.csv']) {
      expect(await screen.findByRole('button', { name: `Preview ${name}` })).toBeTruthy()
    }
    expect(api.resolve).toHaveBeenCalledWith({ agentId: 'folder:a', candidates: ['in/a.csv', 'out/b.csv'] })
    expect(api.resolve).toHaveBeenCalledWith({ agentId: 'folder:b', candidates: ['b/u.csv', 'b/c.csv'] })
    expect(api.resolve).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /r2?\.csv/ })).toBeNull()
    expect(screen.getByText('r.csv').tagName).toBe('CODE')
  })

  it('leave the streaming bubble unlinked', async () => {
    useChatStore.setState({
      isStreaming: true,
      streamingBlocks: [{ type: 'text', kind: 'text', content: 'Also `in/a.csv`' }] as never
    })
    renderStream()
    expect(await screen.findByRole('button', { name: 'Preview in/a.csv' })).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('in/a.csv')).toHaveLength(2))
    expect(screen.getAllByRole('button', { name: 'Preview in/a.csv' })).toHaveLength(1)
  })
})
