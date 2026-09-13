import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import { composerDraftKey, useComposerDraftStore } from '../../stores/composerDraft.store'

function namespace() {
  return new Proxy({}, { get: (_target, method: string) => method.startsWith('on') ? () => () => {} : async () => [] })
}
window.api = new Proxy({}, { get: () => namespace() }) as never
const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
beforeEach(() => {
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: null })
})
function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

it('restores text, notes and files across entry pages and actual component unmounts', () => {
  const dashboard = composerDraftKey(undefined, 'dashboard')
  useComposerDraftStore.getState().update(dashboard, () => ({
    notes: [{ id: 'n1', title: 'My plan' }],
    files: { attachments: [{ id: '/tmp/brief.pdf', filename: 'brief.pdf', source: 'pending', size: 42, mimeType: 'application/pdf' }], uploading: false, error: null, token: null }
  }))
  const first = render(<ChatInput chatId={null} />, { wrapper })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Dashboard\nmessage' } })
  first.unmount()
  const second = render(<ChatInput chatId={null} draftKey="agent-1" />, { wrapper })
  expect(screen.getByRole('combobox')).toHaveProperty('value', '')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Agent message' } })
  second.rerender(<ChatInput chatId="chat-1" />)
  expect(screen.getByRole('combobox')).toHaveProperty('value', '')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Existing chat message' } })
  second.rerender(<ChatInput chatId={null} />)
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'Dashboard\nmessage')
  expect(screen.getByRole('combobox')).toHaveProperty('selectionStart', 'Dashboard\nmessage'.length)
  expect(screen.getByRole('combobox')).toHaveProperty('selectionEnd', 'Dashboard\nmessage'.length)
  expect(screen.getByText('My plan')).toBeTruthy()
  expect(screen.getByText('brief.pdf')).toBeTruthy()
  second.rerender(<ChatInput chatId={null} draftKey="agent-1" />)
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'Agent message')
  expect(screen.getByRole('combobox')).toHaveProperty('selectionStart', 'Agent message'.length)
  second.rerender(<ChatInput chatId="chat-1" />)
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'Existing chat message')
})

it.each([true, false])('consumes only the originating draft after send success=%s', async (success) => {
  let finish!: (result: boolean) => void
  const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  const { rerender } = render(<ChatInput chatId={null} onNewChat={send} />, { wrapper })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Send this later' } })
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  rerender(<ChatInput chatId="chat-2" />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Keep this draft' } })
  await act(async () => finish(success))
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'Keep this draft')
  rerender(<ChatInput chatId={null} onNewChat={send} />)
  expect(screen.getByRole('combobox')).toHaveProperty('value', success ? '' : 'Send this later')
})

it('keeps newer text entered in the source composer while a send is preparing', async () => {
  let finish!: (result: boolean) => void
  const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  render(<ChatInput chatId={null} onNewChat={send} />, { wrapper })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'First message' } })
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'My next message' } })
  await act(async () => finish(true))
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'My next message')
})

it('prevents duplicate preparation after the source composer unmounts and allows retry after failure', async () => {
  let finish!: (result: boolean) => void
  const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  const first = render(<ChatInput chatId={null} onNewChat={send} />, { wrapper })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Start once' } })
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  first.unmount()
  render(<ChatInput chatId={null} onNewChat={send} />, { wrapper })
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  expect(send).toHaveBeenCalledTimes(1)
  await act(async () => finish(false))
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'Start once')
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false)
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  expect(send).toHaveBeenCalledTimes(2)
  await act(async () => finish(true))
  expect(screen.getByRole('combobox')).toHaveProperty('value', '')
})
