import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunQueueView } from '../../../../shared/ipcPayloads'
import type { RunWatchMessage } from '../../../../shared/runWatch'

/**
 * A queue draining as its turn ends, through the real watcher, the real chat
 * read and the real transcript: main closes the turn, announces the queue left,
 * starts the next turn — and only then does the ended turn's saved transcript
 * come back from the read the close started.
 */

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useAgentRequests', () => ({ useAgentRequests: () => ({ isPending: () => false }) }))
vi.mock('../../hooks/useStickToBottom', () => ({ useStickToBottom: () => ({ containerRef: { current: null }, contentRef: { current: null }, pinned: true, scrollToBottom: () => {} }) }))
vi.mock('./MessageMetaFooter', () => ({ MessageMetaFooter: () => null }))
;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => {} } }
const { MessageStream } = await import('./MessageStream')
const { useLiveRunWatch } = await import('../../hooks/useLiveRunWatch')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')

type SavedChat = { messages: unknown[]; activeRunId: string | null }
const question = { id: 'u-1', role: 'user', content: 'First question' }
const answer = { id: 'a-1', role: 'assistant', content: 'Previous answer' }
const drained = { id: 'u-2', role: 'user', content: 'Queued one' }

let watchers: Array<(message: RunWatchMessage) => void>
let pushQueue: (payload: { chatId: string; view: RunQueueView }) => void
let saved: SavedChat
let get: ReturnType<typeof vi.fn>

beforeEach(() => {
  watchers = []
  saved = { messages: [question], activeRunId: 'r1' }
  get = vi.fn(async () => saved)
  ;(window as unknown as { api: unknown }).api = {
    app: { setTheme: async () => {} },
    run: {
      watch: vi.fn((_chatId: string, callback: (message: RunWatchMessage) => void) => { watchers.push(callback); return () => {} }),
      cancel: vi.fn(),
      queueList: vi.fn(async (): Promise<RunQueueView> => ({ items: [{ id: 'q-1', content: 'Queued one', createdAt: 1 }], held: false })),
      queueRemove: vi.fn(async () => true),
      onQueueChanged: vi.fn((handler: typeof pushQueue) => { pushQueue = handler; return () => {} })
    },
    chat: { get },
    agentStatus: { get: vi.fn(), list: vi.fn() },
    agents: { checkReadiness: vi.fn().mockResolvedValue(null) }
  }
  useChatStore.getState().reset()
  useChatStore.getState().setActiveChatId('a')
  useAuthStore.setState({ currentUser: { id: 'u', type: 'local_user' } as never })
})

function Transcript(): React.JSX.Element {
  useLiveRunWatch()
  return <MessageStream chatId="a" />
}
const emit = (message: RunWatchMessage): void => act(() => watchers.at(-1)!(message))
const tick = (ms = 0): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

describe('a queue draining into the next turn', () => {
  it('keeps the ended turn’s output and the sent message on screen until their saved rows are read', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><Transcript /></QueryClientProvider>)
    emit({ type: 'snapshot', runId: 'r1', sequence: 1, active: true, agentId: null, replayAvailable: true,
      baselineMessageIds: ['u-1'], events: [{ type: 'request-id', requestId: 'req-1' }, { type: 'delta', kind: 'text', text: 'Previous answer' }] })
    await screen.findByText('Queued one')
    await screen.findByText('First question')
    await waitFor(() => expect(client.isFetching()).toBe(0))

    // From here on, no committed DOM may lack either.
    const gaps: string[] = []
    const observer = new MutationObserver(() => {
      const text = document.body.textContent ?? ''
      if (!text.includes('Previous answer')) gaps.push('the ended turn’s output')
      if (!text.includes('Queued one')) gaps.push('the sent message')
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })

    // The turn ends with its answer saved; the read its close starts is slow.
    saved = { messages: [question, answer], activeRunId: null }
    let land: (() => void) | undefined
    get.mockImplementationOnce(() => new Promise((resolve) => { land = () => resolve({ messages: [question, answer], activeRunId: null }) }))
    emit({ type: 'closed', runId: 'r1', sequence: 2, agentId: null })
    await waitFor(() => expect(land).toBeDefined())
    // Main announces the queue left, then starts the turn that sends it.
    await act(async () => { pushQueue({ chatId: 'a', view: { items: [], held: false } }) })
    emit({ type: 'snapshot', runId: 'r2', sequence: 0, active: true, agentId: null, replayAvailable: true,
      baselineMessageIds: ['u-1', 'a-1'], events: [{ type: 'request-id', requestId: 'req-2' }] })
    await tick(10)
    expect(gaps).toEqual([])
    expect(screen.getAllByText('Previous answer')).toHaveLength(1)
    expect(document.querySelector('[data-queued-message]')?.getAttribute('data-phase')).toBe('sent')

    // The saved read lands; the next turn's own read brings the sent message's row.
    saved = { messages: [question, answer, drained], activeRunId: 'r2' }
    await act(async () => { land!() })
    await waitFor(() => expect(document.querySelector('[data-queued-message]')).toBeNull())
    await tick()
    observer.disconnect()
    expect(gaps).toEqual([])
    expect(screen.getAllByText('Previous answer')).toHaveLength(1)
    expect(screen.getAllByText('Queued one')).toHaveLength(1)
    expect(useChatStore.getState().isStreaming).toBe(true)
    view.unmount()
  })
})
