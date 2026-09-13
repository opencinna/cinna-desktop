import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useChatDetail, useChatList } from './useChat'
import { useChatStore } from '../stores/chat.store'

afterEach(() => { cleanup(); vi.useRealTimers(); useChatStore.setState({ activeChatId: null, isStreaming: false }) })

it('refreshes sidebar activity when an unselected session starts and stops', async () => {
  vi.useFakeTimers()
  const list = vi.fn().mockResolvedValue([{ id: 'background', activeRunId: null }])
  ;(window as unknown as { api: unknown }).api = { chat: { list, onTitleUpdated: () => () => {} } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const view = renderHook(() => useChatList(), { wrapper })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  expect(view.result.current.data?.[0].activeRunId).toBeNull()
  list.mockResolvedValue([{ id: 'background', activeRunId: 'run-1' }])
  await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
  expect(view.result.current.data?.[0].activeRunId).toBe('run-1')
  list.mockResolvedValue([{ id: 'background', activeRunId: null }])
  await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
  expect(view.result.current.data?.[0].activeRunId).toBeNull()
  client.clear()
})

it('polls detached runs through completion, but leaves attached streamed history to its port', async () => {
  vi.useFakeTimers()
  const get = vi.fn().mockResolvedValue({ id: 'watched', activeRunId: 'run-1', messages: [] })
  ;(window as unknown as { api: unknown }).api = { chat: { get } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['chat', 'watched'], { id: 'watched', activeRunId: 'run-1', messages: [] })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  useChatStore.setState({ activeChatId: 'watched', isStreaming: true })
  const view = renderHook(() => useChatDetail('watched'), { wrapper })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  get.mockClear()
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(get).not.toHaveBeenCalled()

  // A different chat's port must not suppress this headless run's refresh.
  act(() => useChatStore.setState({ activeChatId: 'other', isStreaming: true }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
  expect(get).toHaveBeenCalledWith('watched')
  get.mockResolvedValue({ id: 'watched', activeRunId: null, messages: [{ content: 'Done' }] })
  await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
  expect(view.result.current.data?.messages).toEqual([{ content: 'Done' }])
  get.mockClear()
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(get).not.toHaveBeenCalled()
  client.clear()
})
