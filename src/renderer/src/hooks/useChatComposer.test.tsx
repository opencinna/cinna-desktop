import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { MessageAttachment } from '../../../shared/attachments'

const { startRun } = vi.hoisted(() => ({ startRun: vi.fn() }))
vi.mock('./useChatStream', () => ({ useChatStream: () => ({ startRun }) }))
const { useChatComposer } = await import('./useChatComposer')

function mount(cached: boolean) {
  const client = new QueryClient()
  if (cached) client.setQueryData(['chat', 'chat-1'], { id: 'chat-1', router: 'direct', agentId: null })
  return renderHook(() => useChatComposer('chat-1'), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  })
}

it('dispatches an attachment-only turn and reports that the draft was consumed', async () => {
  startRun.mockClear()
  const attachments: MessageAttachment[] = [{ id: 'f1', source: 'local', filename: 'brief.txt', mimeType: 'text/plain', size: 5 }]
  const { result } = mount(true)
  await act(async () => expect(await result.current.submit('', attachments)).toBe(true))
  expect(startRun).toHaveBeenCalledWith('chat-1', '', { attachments, target: { kind: 'model' } })
})

it('does not consume a draft when its chat has not loaded', async () => {
  startRun.mockClear()
  const { result } = mount(false)
  await act(async () => expect(await result.current.submit('Keep this text')).toBe(false))
  expect(startRun).not.toHaveBeenCalled()
})
