import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useReadChatResult } from './useReadChatResult'

const markResultRead = vi.fn()
const get = vi.fn()
const chats = () => [
  { id: 'a', activeRunId: null, lastRunResult: { runId: 'run-a', status: 'completed', unread: true } },
  { id: 'b', activeRunId: null, lastRunResult: { runId: 'run-b', status: 'needs_input', unread: true } }
]
let client: QueryClient
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['chats'], chats())
  markResultRead.mockReset().mockResolvedValue(undefined)
  get.mockReset().mockImplementation(async (id: string) => ({ ...chats().find((chat) => chat.id === id), messages: [] }))
  ;(window as unknown as { api: unknown }).api = { chat: {
    list: vi.fn().mockResolvedValue(chats()), get, markResultRead, onTitleUpdated: () => () => {}
  } }
})
afterEach(() => { client.clear(); vi.restoreAllMocks() })
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const cached = () => client.getQueryData<ReturnType<typeof chats>>(['chats'])!

it('leaves background results unread until their chat is opened', async () => {
  const view = renderHook(({ id }) => useReadChatResult(id), { initialProps: { id: null as string | null }, wrapper })
  expect(markResultRead).not.toHaveBeenCalled()
  view.rerender({ id: 'a' })
  await waitFor(() => expect(cached()[0].lastRunResult.unread).toBe(false))
  expect(markResultRead).toHaveBeenCalledWith('a', 'run-a')
  expect(cached()[1].lastRunResult.unread).toBe(true)
})

it('does not let a delayed read acknowledgement clear a newer background result', async () => {
  let finish!: () => void
  markResultRead.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
  const view = renderHook(({ id }) => useReadChatResult(id), { initialProps: { id: 'a' as string | null }, wrapper })
  await waitFor(() => expect(markResultRead).toHaveBeenCalledWith('a', 'run-a'))
  view.rerender({ id: null })
  act(() => client.setQueryData(['chats'], [{ ...chats()[0], lastRunResult: { runId: 'run-new', status: 'failed', unread: true } }]))
  await act(async () => finish())
  expect(cached()[0].lastRunResult).toEqual({ runId: 'run-new', status: 'failed', unread: true })
})

it('does not acknowledge an old result while a new run is active', () => {
  client.setQueryData(['chats'], [{ ...chats()[0], activeRunId: 'run-new' }])
  renderHook(() => useReadChatResult('a'), { wrapper })
  expect(markResultRead).not.toHaveBeenCalled()
})

it('keeps the result unread if its transcript arrives only after the user leaves', async () => {
  let finish!: (value: unknown) => void
  get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const view = renderHook(({ id }) => useReadChatResult(id), { initialProps: { id: 'a' as string | null }, wrapper })
  await waitFor(() => expect(get).toHaveBeenCalledWith('a'))
  expect(markResultRead).not.toHaveBeenCalled()
  view.rerender({ id: null })
  await act(async () => finish({ ...chats()[0], messages: [{ content: 'Finished' }] }))
  expect(markResultRead).not.toHaveBeenCalled()
  expect(cached()[0].lastRunResult.unread).toBe(true)
})

it('does not acknowledge a result after a failed transcript read', async () => {
  get.mockRejectedValue(new Error('Database unavailable'))
  renderHook(() => useReadChatResult('a'), { wrapper })
  await waitFor(() => expect(client.getQueryState(['chat', 'a'])?.status).toBe('error'))
  expect(markResultRead).not.toHaveBeenCalled()
  expect(cached()[0].lastRunResult.unread).toBe(true)
})

it('requires the transcript to contain the latest result identity', () => {
  client.setQueryData(['chat', 'a'], { ...chats()[0], lastRunResult: { runId: 'older-run', status: 'completed', unread: false }, messages: [] })
  renderHook(() => useReadChatResult('a'), { wrapper })
  expect(markResultRead).not.toHaveBeenCalled()
})

it('keeps results unread while the app is in the background and reads them on focus', async () => {
  vi.mocked(document.hasFocus).mockReturnValue(false)
  renderHook(() => useReadChatResult('a'), { wrapper })
  expect(markResultRead).not.toHaveBeenCalled()
  act(() => {
    vi.mocked(document.hasFocus).mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
  })
  await waitFor(() => expect(markResultRead).toHaveBeenCalledWith('a', 'run-a'))
})
