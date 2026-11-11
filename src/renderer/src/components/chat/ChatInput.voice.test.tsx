import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useEffect, useState, type ReactNode } from 'react'

// The voice button, reduced to its mounts and the props the composer gives it.
type VoiceProps = { onText: (text: string) => void; onError: (message: string | null) => void; onSend: () => void }
const voice = vi.hoisted(() => ({ mounts: [] as VoiceProps[], unmounts: 0, shown: true }))
vi.mock('./voice/VoiceInputButton', () => ({
  VoiceInputButton: (props: VoiceProps) => {
    useEffect(() => {
      voice.mounts.push(props)
      return () => { voice.unmounts += 1 }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  },
  useVoiceInputShown: () => voice.shown
}))

function namespace() {
  return new Proxy({}, { get: (_target, method: string) => method.startsWith('on') ? () => () => {} : async () => [] })
}
window.api = new Proxy({}, { get: () => namespace() }) as never
const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useComposerDraftStore } = await import('../../stores/composerDraft.store')
beforeEach(() => {
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: null })
  voice.mounts.length = 0
  voice.unmounts = 0
  voice.shown = true
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

// The row is never empty: the mic stands alone on an empty draft, Send joins
// it once there is something to send, and without the mic Send is there disabled.
const sendButton = (): HTMLButtonElement | null => screen.queryByRole('button', { name: 'Send' }) as HTMLButtonElement | null

it('leaves Send out of an empty draft while the mic is shown, and brings it back with the first character', () => {
  render(<ChatInput chatId="chat-1" draftKey="voice-send-row" />, { wrapper })
  expect(sendButton()).toBeNull()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'h' } })
  expect(sendButton()).toHaveProperty('disabled', false)
})

it('holds a disabled Send in its slot for a moment after it leaves, so the mic never slides under a click', () => {
  vi.useFakeTimers()
  try {
    render(<ChatInput chatId="chat-1" draftKey="voice-send-row-hold" />, { wrapper })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'h' } })
    expect(sendButton()).toHaveProperty('disabled', false)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '   ' } })
    expect(sendButton()).toHaveProperty('disabled', true)
    act(() => { vi.advanceTimersByTime(799) })
    expect(sendButton()).toHaveProperty('disabled', true)
    act(() => { vi.advanceTimersByTime(1) })
    expect(sendButton()).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('does not hold Send across a chat switch: the new empty draft shows the mic alone at once', () => {
  const { rerender } = render(<ChatInput chatId="chat-1" draftKey="voice-hold-a" />, { wrapper })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'typed in a' } })
  expect(sendButton()).not.toBeNull()
  rerender(<ChatInput chatId="chat-2" draftKey="voice-hold-b" />)
  expect(sendButton()).toBeNull()
})

it('keeps a disabled Send on an empty draft when the mic is not shown', () => {
  voice.shown = false
  render(<ChatInput chatId="chat-1" draftKey="voice-send-row-off" />, { wrapper })
  expect(sendButton()).toHaveProperty('disabled', true)
})

it('keeps a disabled Send while a first send is in flight, even once the draft is empty', () => {
  act(() => useComposerDraftStore.getState().update('voice-send-row-sending', () => ({ text: '', sending: true })))
  render(<ChatInput chatId={null} draftKey="voice-send-row-sending" onNewChat={async () => true} />, { wrapper })
  expect(sendButton()).toHaveProperty('disabled', true)
})
