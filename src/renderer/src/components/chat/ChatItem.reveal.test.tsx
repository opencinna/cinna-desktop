import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useUIStore } from '../../stores/ui.store'
import { useChatStore } from '../../stores/chat.store'

/**
 * The task page's "Show in the Chats list": the row brings itself into view and
 * lights up for a moment, and the chat is **not** opened — the user stays on
 * the task they were reading.
 */

;(window as unknown as { api: unknown }).api = { app: { setTheme: vi.fn().mockResolvedValue(undefined) } }
const { ChatItem } = await import('./ChatItem')
const chat = { id: 'job-chat', title: 'Nightly check', updatedAt: new Date() }
const scrollIntoView = vi.fn()

beforeEach(() => {
  scrollIntoView.mockReset()
  Element.prototype.scrollIntoView = scrollIntoView
  useUIStore.setState({ activeView: 'task', revealChatId: null })
  useChatStore.setState({ activeChatId: 'other-chat', isStreaming: false })
})
afterEach(() => {
  vi.useRealTimers()
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

function mount() {
  const client = new QueryClient()
  return render(<QueryClientProvider client={client}><ChatItem chat={chat} /></QueryClientProvider>)
}

function rowEl(): HTMLElement {
  return screen.getByText('Nightly check').parentElement as HTMLElement
}

it('scrolls to the row and lights it once, without opening the chat', () => {
  vi.useFakeTimers()
  mount()
  act(() => useUIStore.getState().setRevealChatId('job-chat'))
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  expect(rowEl().dataset.revealed).toBe('true')
  expect(useUIStore.getState().revealChatId).toBeNull()
  expect(useUIStore.getState().activeView).toBe('task')
  expect(useChatStore.getState().activeChatId).toBe('other-chat')
  act(() => vi.advanceTimersByTime(2_000))
  expect(rowEl().dataset.revealed).toBeUndefined()
})

it('reveals a row that only appears after the request, as a chat moved out of hiding does', () => {
  useUIStore.setState({ revealChatId: 'job-chat' })
  mount()
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  expect(rowEl().dataset.revealed).toBe('true')
})

it('leaves other rows alone', () => {
  mount()
  act(() => useUIStore.getState().setRevealChatId('another-chat'))
  expect(scrollIntoView).not.toHaveBeenCalled()
  expect(rowEl().dataset.revealed).toBeUndefined()
  expect(useUIStore.getState().revealChatId).toBe('another-chat')
})
