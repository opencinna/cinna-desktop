import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useEffect, useState, type ReactNode } from 'react'

// The voice button, reduced to its mounts and the props the composer gives it.
type VoiceProps = { onText: (text: string) => void; onError: (message: string | null) => void; onSend: () => void }
const voice = vi.hoisted(() => ({ mounts: [] as VoiceProps[], unmounts: 0 }))
vi.mock('./voice/VoiceInputButton', () => ({
  VoiceInputButton: (props: VoiceProps) => {
    useEffect(() => {
      voice.mounts.push(props)
      return () => { voice.unmounts += 1 }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  }
}))

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
  voice.mounts.length = 0
  voice.unmounts = 0
})
function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

it('remounts the voice button on a chat switch, and a late transcription lands in the chat it was dictated in', () => {
  const { rerender } = render(<ChatInput chatId="chat-1" />, { wrapper })
  expect(voice.mounts).toHaveLength(1)
  const dictatedInFirst = voice.mounts[0]
  rerender(<ChatInput chatId="chat-2" />)
  expect(voice.unmounts).toBe(1)
  expect(voice.mounts).toHaveLength(2)
  act(() => dictatedInFirst.onText('late words'))
  expect(screen.getByRole('combobox')).toHaveProperty('value', '')
  rerender(<ChatInput chatId="chat-1" />)
  expect(screen.getByRole('combobox')).toHaveProperty('value', 'late words')
})
