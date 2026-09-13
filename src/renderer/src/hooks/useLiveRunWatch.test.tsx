import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunWatchMessage } from '../../../shared/runWatch'
import type { RunEvent } from '../../../shared/runEvents'
;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => {} } }
const { useLiveRunWatch } = await import('./useLiveRunWatch')
const { useChatStore } = await import('../stores/chat.store')
const { useAuthStore } = await import('../stores/auth.store')
const { useUIStore } = await import('../stores/ui.store')
const { useChatList } = await import('./useChat')
const { ChatItem } = await import('../components/chat/ChatItem')
const delta = (text: string): RunEvent => ({ type: 'delta', kind: 'text', text })
const snapshot = (runId = 'r', events: RunEvent[] = [], sequence = 0): RunWatchMessage => ({
  type: 'snapshot', runId, sequence, active: true, agentId: null, replayAvailable: true,
  baselineMessageIds: ['old'], events
})
let client: QueryClient
let callbacks: Array<(message: RunWatchMessage) => void>
let detach: ReturnType<typeof vi.fn>
let get: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
function mount() {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useLiveRunWatch(), { wrapper })
}
function emit(message: RunWatchMessage, index = callbacks.length - 1) { act(() => callbacks[index](message)) }
function text() { return useChatStore.getState().streamingBlocks.map((b) => b.type === 'text' ? b.content : '').join('') }
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  callbacks = []; detach = vi.fn(); cancel = vi.fn()
  get = vi.fn().mockResolvedValue({ messages: [], activeRunId: null })
  ;(window as unknown as { api: unknown }).api = {
    app: { setTheme: async () => {} },
    run: { watch: vi.fn((_chatId: string, cb: (m: RunWatchMessage) => void) => { callbacks.push(cb); return detach }), cancel },
    chat: { get },
    agentStatus: { get: vi.fn(), list: vi.fn() }, agents: { checkReadiness: vi.fn().mockResolvedValue(null) }
  }
  useChatStore.getState().reset()
  useChatStore.getState().setActiveChatId('a')
  useAuthStore.setState({ currentUser: { id: 'u', type: 'local_user' } as never })
})
describe('selected chat live subscription', () => {
  it('leaves an unseen result unread when replay is unavailable and the user leaves before settlement', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const markRead = vi.fn().mockResolvedValue(undefined)
    window.api.chat.markResultRead = markRead
    get.mockReturnValue(new Promise(() => {}))
    useUIStore.setState({ activeView: 'chat' })
    const view = mount()
    try {
      emit({ ...snapshot('run-seen'), replayAvailable: false } as RunWatchMessage)
      emit({ type: 'closed', runId: 'run-seen', sequence: 1, agentId: null })
      act(() => useChatStore.getState().setActiveChatId('b'))
      expect(markRead).not.toHaveBeenCalled()
    } finally { view.unmount(); focus.mockRestore() }
  })

  it('keeps the sidebar spinner across chat switches before a list refresh, even when an older idle read arrives late', async () => {
    vi.useFakeTimers()
    const chats = [
      { id: 'a', title: 'Running chat', updatedAt: new Date(), activeRunId: null },
      { id: 'b', title: 'Other chat', updatedAt: new Date(), activeRunId: null }
    ]
    let finishOldRead!: (value: typeof chats) => void
    const list = vi.fn().mockReturnValueOnce(new Promise((resolve) => { finishOldRead = resolve }))
      .mockResolvedValue(chats)
    window.api.chat.list = list
    window.api.chat.onTitleUpdated = () => () => {}
    client.setQueryData(['chats'], chats)
    function Sidebar() {
      useLiveRunWatch()
      const { data } = useChatList()
      return <>{data?.map((chat) => <ChatItem key={chat.id} chat={chat} />)}</>
    }
    const view = render(<QueryClientProvider client={client}><Sidebar /></QueryClientProvider>)
    try {
      emit(snapshot('run-a', [{ type: 'request-id', requestId: 'request-a' }]))
      // Switch immediately, while the list still has its pre-run read in flight.
      fireEvent.click(screen.getByText('Other chat'))
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      const runningRow = within(screen.getByText('Running chat').parentElement!)
      expect(runningRow.getByRole('button', { name: 'Interrupt session' })).toBeTruthy()
      expect(runningRow.queryByRole('button', { name: 'Delete session' })).toBeNull()
      expect(within(screen.getByText('Other chat').parentElement!).getByRole('button', { name: 'Delete session' })).toBeTruthy()
      expect(useChatStore.getState().isStreaming).toBe(false)

      await act(async () => { finishOldRead(chats); await vi.advanceTimersByTimeAsync(10) })
      expect(runningRow.getByRole('button', { name: 'Interrupt session' })).toBeTruthy()

      // The background run ends; polling still retires its indicator.
      await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
      expect(runningRow.getByRole('button', { name: 'Delete session' })).toBeTruthy()
    } finally {
      view.unmount()
      client.clear()
      vi.useRealTimers()
    }
  })

  it('replays once, ignores overlapping sequence delivery, detaches without cancel and isolates another chat', () => {
    const view = mount()
    emit(snapshot('r', [{ type: 'request-id', requestId: 'req' }, delta('one')], 2))
    emit({ type: 'event', runId: 'r', sequence: 2, agentId: null, event: delta('duplicate') })
    emit({ type: 'event', runId: 'r', sequence: 3, agentId: null, event: delta('two') })
    expect(text()).toBe('onetwo')
    act(() => useChatStore.getState().setActiveChatId('b'))
    emit({ type: 'event', runId: 'r', sequence: 4, agentId: null, event: delta('late') }, 0)
    expect(text()).toBe('')
    expect(detach).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    act(() => useChatStore.getState().setActiveChatId('a'))
    emit(snapshot('r', [{ type: 'request-id', requestId: 'req' }, delta('onetwolate')], 4))
    expect(text()).toBe('onetwolate')
    expect(useChatStore.getState().isStreaming).toBe(true)
    view.unmount()
  })
  it('retains the projection on a failed terminal read and retires it after read recovery', async () => {
    const view = mount()
    emit(snapshot('r', [delta('partial')], 1))
    get.mockRejectedValueOnce(new Error('DB busy'))
    emit({ type: 'closed', runId: 'r', sequence: 2, agentId: null })
    await waitFor(() => expect(client.getQueryState(['chat', 'a'])?.status).toBe('error'))
    expect(text()).toBe('partial')
    expect(useChatStore.getState().liveBaselineMessageIds).toEqual(['old'])
    await act(async () => { await client.fetchQuery({ queryKey: ['chat', 'a'], queryFn: () => get('a') }) })
    await waitFor(() => expect(useChatStore.getState().liveBaselineMessageIds).toBeNull())
    expect(text()).toBe('')
    view.unmount()
  })
  it('an old terminal read cannot clear a new run', async () => {
    let finish!: (value: unknown) => void
    get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const view = mount()
    emit(snapshot('r', [delta('first')]))
    emit({ type: 'closed', runId: 'r', sequence: 1, agentId: null })
    await waitFor(() => expect(get).toHaveBeenCalled())
    emit(snapshot('r2', [delta('second')]))
    await act(async () => { finish({ messages: [], activeRunId: null }) })
    expect(text()).toBe('second')
    expect(useChatStore.getState().liveBaselineMessageIds).toEqual(['old'])
    view.unmount()
  })
  it('an old read cannot clear a rebuilt projection after leaving and returning to the same chat', async () => {
    let finish!: (value: unknown) => void
    get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const view = mount()
    emit(snapshot('r', [delta('first')]))
    emit({ type: 'closed', runId: 'r', sequence: 1, agentId: null })
    await waitFor(() => expect(get).toHaveBeenCalled())
    act(() => useChatStore.getState().setActiveChatId('b'))
    act(() => useChatStore.getState().setActiveChatId('a'))
    emit(snapshot('r', [delta('rebuilt')]))
    await act(async () => { finish({ messages: [], activeRunId: null }) })
    expect(text()).toBe('rebuilt')
    expect(useChatStore.getState().liveBaselineMessageIds).toEqual(['old'])
    view.unmount()
  })
  it('idle attachment after fast completion retires its optimistic send only after the saved read', async () => {
    const pending = { content: 'question', baselineUserCount: 0 }
    useChatStore.getState().setPendingUserMessage(pending)
    const view = mount()
    emit({ type: 'snapshot', runId: null, sequence: 0, active: false, agentId: null,
      replayAvailable: true, baselineMessageIds: [], events: [] })
    await waitFor(() => expect(useChatStore.getState().pendingUserMessage).toBeNull())
    expect(get).toHaveBeenCalledWith('a')
    view.unmount()
  })
  it('overflow attachment uses saved polling and clears pending state on close', async () => {
    useChatStore.getState().setPendingUserMessage({ content: 'question', baselineUserCount: 0 })
    const view = mount()
    emit({ ...snapshot(), replayAvailable: false, baselineMessageIds: [] } as RunWatchMessage)
    emit({ type: 'event', runId: 'r', sequence: 1, agentId: null, event: delta('only the tail') })
    expect(text()).toBe('')
    expect(useChatStore.getState().liveBaselineMessageIds).toBeNull()
    expect(useChatStore.getState().isStreaming).toBe(false)
    emit({ type: 'closed', runId: 'r', sequence: 2, agentId: null })
    await waitFor(() => expect(useChatStore.getState().pendingUserMessage).toBeNull())
    view.unmount()
  })
  it('ignores an old profile callback even before React cleans up its effect', () => {
    const view = mount()
    emit(snapshot('r', [delta('private')]))
    act(() => {
      useChatStore.getState().reset()
      useChatStore.getState().setActiveChatId('a')
      useAuthStore.setState({ currentUser: { id: 'other', type: 'local_user' } as never })
      callbacks[0]({ type: 'event', runId: 'r', sequence: 1, agentId: null, event: delta('leak') })
    })
    expect(text()).toBe('')
    view.unmount()
  })
})
