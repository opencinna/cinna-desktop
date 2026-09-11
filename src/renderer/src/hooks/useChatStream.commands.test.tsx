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
  start = vi.fn().mockResolvedValue('run')
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
