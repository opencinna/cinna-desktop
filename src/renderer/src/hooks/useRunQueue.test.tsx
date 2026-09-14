import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunQueueView } from '../../../shared/ipcPayloads'

type QueuePush = { chatId: string; view: RunQueueView }
const run = vi.hoisted(() => ({
  queueList: vi.fn(),
  onQueueChanged: vi.fn((_handler: (payload: { chatId: string; view: RunQueueView }) => void) => () => undefined)
}))
;(window as unknown as { api: unknown }).api = { run }
const { useRunQueue } = await import('./useRunQueue')

const view = (...texts: string[]): RunQueueView => ({
  items: texts.map((content, index) => ({ id: `q-${index + 1}`, content, createdAt: index })),
  held: false
})

let client: QueryClient
beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

function mount(chatId: string) {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  const hook = renderHook(() => useRunQueue(chatId), { wrapper })
  const push = (payload: QueuePush): void => act(() => run.onQueueChanged.mock.calls.at(-1)![0](payload))
  return { hook, push }
}

describe('useRunQueue', () => {
  it('shows the view main pushed, in the order main pushed it, without reading the queue again', async () => {
    run.queueList.mockResolvedValue(view('first'))
    const { hook, push } = mount('chat')
    await waitFor(() => expect(hook.result.current.data).toEqual(view('first')))

    // A read now would still answer with the message queued: the drain's push
    // is the only thing that knows it left.
    run.queueList.mockResolvedValue(view('first'))
    push({ chatId: 'chat', view: view() })
    await waitFor(() => expect(hook.result.current.data).toEqual(view()))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(hook.result.current.data).toEqual(view())
    expect(run.queueList).toHaveBeenCalledTimes(1)
  })

  it("ignores another chat's queue", async () => {
    run.queueList.mockResolvedValue(view('mine'))
    const { hook, push } = mount('chat')
    await waitFor(() => expect(hook.result.current.data).toEqual(view('mine')))
    push({ chatId: 'other', view: view() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(hook.result.current.data).toEqual(view('mine'))
    expect(client.getQueryData(['run-queue', 'other'])).toBeUndefined()
  })
})
