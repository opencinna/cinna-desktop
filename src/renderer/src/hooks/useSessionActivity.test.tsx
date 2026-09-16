import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionActivityChangedPayload,
  SessionActivityGetResult,
  SessionActivityItem,
  SessionActivitySnapshot
} from '../../../shared/sessionActivity'

const listeners: Array<(payload: SessionActivityChangedPayload) => void> = []
const get = vi.fn<(chatId: string) => Promise<SessionActivityGetResult>>()

;(window as unknown as { api: unknown }).api = {
  sessionActivity: {
    get,
    onChanged: (handler: (payload: SessionActivityChangedPayload) => void) => {
      listeners.push(handler)
      return () => listeners.splice(listeners.indexOf(handler), 1)
    }
  }
}

const { useSessionActivity } = await import('./useSessionActivity')

const item = (id: string): SessionActivityItem => ({
  id, kind: 'background', agentId: 'agent', title: `title ${id}`, detail: null, state: 'running',
  startedAt: new Date(0), endedAt: null, outputPath: null, canStop: false
})
const snapshot = (chatId: string, ...ids: string[]): SessionActivitySnapshot => ({ chatId, items: ids.map(item) })

function render(chatId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  return { client, ...renderHook(({ id }) => useSessionActivity(id), { wrapper, initialProps: { id: chatId } }) }
}

beforeEach(() => {
  get.mockReset()
  listeners.length = 0
})

describe('useSessionActivity', () => {
  it('reads the snapshot, then takes this chat\'s pushes and ignores other chats\'', async () => {
    get.mockResolvedValue({ ok: true, snapshot: snapshot('c1', 'a') })
    const { result, client } = render('c1')
    await waitFor(() => expect(result.current.data?.items.map((i) => i.id)).toEqual(['a']))
    expect(get).toHaveBeenCalledWith('c1')

    await act(async () => { for (const listener of [...listeners]) listener({ chatId: 'c2', snapshot: snapshot('c2', 'other') }) })
    // The cache is written synchronously; the render follows a tick later.
    const cached = (): string[] | undefined =>
      client.getQueryData<SessionActivitySnapshot>(['sessionActivity', 'c1'])?.items.map((i) => i.id)
    expect(cached()).toEqual(['a'])
    await act(async () => { for (const listener of [...listeners]) listener({ chatId: 'c1', snapshot: snapshot('c1', 'a', 'b') }) })
    expect(cached()).toEqual(['a', 'b'])
    await waitFor(() => expect(result.current.data?.items.map((i) => i.id)).toEqual(['a', 'b']))
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('keeps a push that arrived while the first read was in flight', async () => {
    let answer: (result: SessionActivityGetResult) => void = () => undefined
    get.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const { result } = render('c1')
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    await act(async () => { for (const listener of [...listeners]) listener({ chatId: 'c1', snapshot: snapshot('c1', 'pushed') }) })
    // The read main answered before the push, landing after it.
    await act(async () => { answer({ ok: true, snapshot: snapshot('c1', 'stale') }) })
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    // Mutation: return the read unconditionally and this is ['stale'].
    expect(result.current.data?.items.map((i) => i.id)).toEqual(['pushed'])
  })

  it('reads a chat main refuses as one with no activity', async () => {
    get.mockResolvedValue({ ok: false, code: 'chat_not_found' })
    const { result } = render('gone')
    await waitFor(() => expect(result.current.data).toEqual({ chatId: 'gone', items: [] }))
  })

  it('does nothing without a chat, and unsubscribes on unmount', async () => {
    const empty = render(null)
    expect(get).not.toHaveBeenCalled()
    expect(listeners).toHaveLength(0)
    empty.unmount()

    get.mockResolvedValue({ ok: true, snapshot: snapshot('c1') })
    const { unmount } = render('c1')
    expect(listeners).toHaveLength(1)
    unmount()
    expect(listeners).toHaveLength(0)
  })
})
