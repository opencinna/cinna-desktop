import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => {} } }
const { useChatStream } = await import('./useChatStream')
const { useChatStore } = await import('../stores/chat.store')
let start: ReturnType<typeof vi.fn>
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useChatStream(), { wrapper })
}
beforeEach(() => {
  start = vi.fn().mockResolvedValue({ kind: 'started', runId: 'run' })
  ;(window as unknown as { api: unknown }).api = { run: { start, cancel: vi.fn() } }
  useChatStore.getState().reset()
  useChatStore.getState().setActiveChatId('a')
})
it('submits the routing intent without creating a second transcript subscriber', () => {
  const view = mount()
  act(() => view.result.current.startRun('a', 'hello', { target: { kind: 'agent', agentId: 'agent' } }))
  expect(start).toHaveBeenCalledWith({ chatId: 'a', content: 'hello', attachments: undefined, addressedAgentId: 'agent' })
  expect(useChatStore.getState().pendingUserMessage?.content).toBe('hello')
  expect(useChatStore.getState().streamingBlocks).toEqual([])
  view.unmount()
})
it('shows an admission refusal without Electron implementation details', async () => {
  start.mockRejectedValue(new Error("Error invoking remote method 'run:start': Error: This conversation already has a turn running."))
  const view = mount()
  act(() => view.result.current.startRun('a', 'hello'))
  await waitFor(() => expect(useChatStore.getState().sendError).toBe('This conversation already has a turn running.'))
  expect(useChatStore.getState().pendingUserMessage).toBeNull()
  view.unmount()
})
it('shows no optimistic bubble while a turn runs, and re-engages following', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['chat', 'a'], { messages: [{ role: 'user' }], activeRunId: 'run-1' })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  const view = renderHook(() => useChatStream(), { wrapper })
  const before = useChatStore.getState().sentVersion
  act(() => view.result.current.startRun('a', 'also this'))
  expect(useChatStore.getState().pendingUserMessage).toBeNull()
  expect(useChatStore.getState().sentVersion).toBe(before + 1)
  view.unmount()
})
it('shows the bubble, measured from the send, when a turn this view thought was running had already ended', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['chat', 'a'], { messages: [{ role: 'user' }], activeRunId: 'stale' })
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  let answer!: (result: unknown) => void
  start.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
  const view = renderHook(() => useChatStream(), { wrapper })
  act(() => view.result.current.startRun('a', 'after all'))
  expect(useChatStore.getState().pendingUserMessage).toBeNull()
  // A row landing before the answer must not move the bubble's baseline.
  client.setQueryData(['chat', 'a'], { messages: [{ role: 'user' }, { role: 'user' }], activeRunId: null })
  await act(async () => { answer({ kind: 'started', runId: 'r' }) })
  expect(useChatStore.getState().pendingUserMessage).toEqual({ content: 'after all', baselineUserCount: 1, attachments: undefined })
  view.unmount()
})
function mountRunning() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['chat', 'a'], { messages: [{ role: 'user' }], activeRunId: 'run-1' })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return { view: renderHook(() => useChatStream(), { wrapper }), invalidate }
}
it('refreshes the transcript and the chat list when main saved a message the turn took in too late', async () => {
  start.mockResolvedValueOnce({ kind: 'injected', saved: true })
  const { view, invalidate } = mountRunning()
  act(() => view.result.current.startRun('a', 'late one'))
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chat', 'a'] }))
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chats'] })
  view.unmount()
})
it('leaves the transcript to the turn for a message it took in and will save itself', async () => {
  start.mockResolvedValueOnce({ kind: 'injected' })
  const { view, invalidate } = mountRunning()
  act(() => view.result.current.startRun('a', 'steered'))
  await act(async () => {})
  expect(start).toHaveBeenCalled()
  expect(invalidate).not.toHaveBeenCalled()
  view.unmount()
})
it('a late admission rejection cannot erase another chat or a newer optimistic send', async () => {
  let refuse!: (error: Error) => void
  start.mockReturnValueOnce(new Promise((_resolve, reject) => { refuse = reject }))
  const view = mount()
  act(() => view.result.current.startRun('a', 'old'))
  act(() => { useChatStore.getState().setActiveChatId('b'); view.result.current.startRun('b', 'new') })
  await act(async () => { refuse(new Error('old refusal')) })
  expect(useChatStore.getState().pendingUserMessage?.content).toBe('new')
  expect(useChatStore.getState().sendError).toBeNull()
  view.unmount()
})
