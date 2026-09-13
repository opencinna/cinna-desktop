import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useChatStore } from '../../stores/chat.store'

const cancelChat = vi.fn()
const deleteChat = vi.fn()
;(window as unknown as { api: unknown }).api = {
  app: { setTheme: vi.fn().mockResolvedValue(undefined) },
  run: { cancelChat },
  chat: { delete: deleteChat }
}
const { ChatItem } = await import('./ChatItem')
const chat = { id: 'background-chat', title: 'Background session', updatedAt: new Date() }
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  cancelChat.mockReset().mockResolvedValue(undefined)
  deleteChat.mockReset().mockResolvedValue({ success: true })
  useChatStore.setState({ activeChatId: 'selected-chat', isStreaming: false })
})
afterEach(() => client.clear())

function row(activeRunId: string | null) {
  return <QueryClientProvider client={client}><ChatItem chat={{ ...chat, activeRunId }} /></QueryClientProvider>
}

it('interrupts a background session without selecting or deleting it, then allows deletion after it stops', async () => {
  let finishCancel!: () => void
  cancelChat.mockImplementation(() => new Promise<void>((resolve) => { finishCancel = resolve }))
  const view = render(row('run-1'))
  expect(screen.queryByRole('button', { name: 'Delete session' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt session' }))
  await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(chat.id))
  expect(useChatStore.getState().activeChatId).toBe('selected-chat')
  expect(deleteChat).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'Interrupting session…' }) as HTMLButtonElement).disabled).toBe(true)

  await act(async () => finishCancel())
  // Cancel acknowledges the request before the run actually finishes.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy())
  expect(screen.queryByRole('button', { name: 'Delete session' })).toBeNull()
  view.rerender(row(null))
  fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
  await waitFor(() => expect(deleteChat).toHaveBeenCalledWith(chat.id))
})

it('keeps a running row interruptible after selecting a different chat', () => {
  useChatStore.setState({ activeChatId: chat.id, isStreaming: true })
  render(row('run-1'))
  expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy()
  act(() => useChatStore.getState().setActiveChatId('another-chat'))
  expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Delete session' })).toBeNull()
})

it('shows interruption failures and keeps the running session available to retry', async () => {
  cancelChat.mockRejectedValue(new Error('Could not interrupt'))
  render(row('run-1'))
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt session' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not interrupt'))
  expect((screen.getByRole('button', { name: 'Interrupt session' }) as HTMLButtonElement).disabled).toBe(false)
  expect(deleteChat).not.toHaveBeenCalled()
})

it.each([
  ['completed', 'Completed'], ['needs_input', 'Needs input'], ['failed', 'Failed']
] as const)('shows the unread %s result until it is read, with delete still available', (status, label) => {
  const result = { runId: 'run-1', status, unread: true }
  const content = (unread: boolean, activeRunId: string | null = null) =>
    <QueryClientProvider client={client}><ChatItem chat={{ ...chat, activeRunId, lastRunResult: { ...result, unread } }} /></QueryClientProvider>
  const view = render(content(true))
  expect(screen.getByRole('img', { name: `${label} — unread results` })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Delete session' })).toBeTruthy()
  view.rerender(content(true, 'run-2'))
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy()
  view.rerender(content(false))
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByRole('button', { name: 'Delete session' })).toBeTruthy()
})

it('returns directly to delete after interruption without an unread indicator', () => {
  render(<QueryClientProvider client={client}><ChatItem chat={{ ...chat,
    lastRunResult: { runId: 'run-1', status: 'canceled', unread: false } }} /></QueryClientProvider>)
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByRole('button', { name: 'Delete session' })).toBeTruthy()
})
