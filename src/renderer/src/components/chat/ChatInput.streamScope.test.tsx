import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'

/**
 * The chat store holds one port stream — the chat last on screen's. A composer
 * counts it only when it is its own chat's: a new-chat composer (the agent
 * page's, say) must not show Stop for, or refuse a send because of, another
 * chat's running turn. Its own first send is still guarded until it lands.
 */

function namespace() {
  return new Proxy({}, { get: (_target, method: string) => method.startsWith('on') ? () => () => {} : async () => [] })
}
window.api = new Proxy({}, { get: () => namespace() }) as never
const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')

let key = 0
const nextDraftKey = (): string => `stream-scope-${++key}`

beforeEach(() => {
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: null })
})
function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const streamOf = (chatId: string): void => {
  useChatStore.setState({ activeChatId: chatId, isStreaming: true, activeRequestId: `req-${chatId}` })
}

it('a new-chat composer sends while another chat streams over the port', async () => {
  streamOf('chat-running')
  const send = vi.fn(async () => true)
  render(<ChatInput chatId={null} draftKey={nextDraftKey()} onNewChat={send} />, { wrapper })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'A second session' } })
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false)
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(send.mock.calls[0]).toContain('A second session')
})

it('a chat composer still shows Stop for its own port stream', () => {
  streamOf('chat-1')
  render(<ChatInput chatId="chat-1" draftKey={nextDraftKey()} />, { wrapper })
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
})

it("a chat composer does not take another chat's port stream for its own", () => {
  streamOf('chat-running')
  render(<ChatInput chatId="chat-1" draftKey={nextDraftKey()} />, { wrapper })
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
})

it("refuses a second send while the new chat's first is in flight, even once its stream has started", async () => {
  let finish!: (result: boolean) => void
  const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  render(<ChatInput chatId={null} draftKey={nextDraftKey()} onNewChat={send} />, { wrapper })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Start once' } })
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  // startNewChat has made the created chat active and its turn is streaming,
  // but this composer has not yet been swapped for that chat's.
  act(() => streamOf('chat-new'))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Start again' } })
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(send).toHaveBeenCalledTimes(1)
  await act(async () => finish(true))
})
