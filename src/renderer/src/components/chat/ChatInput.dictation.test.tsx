import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'

// The voice button reduced to the target the composer gives it.
type Target = { draftKey: string; setDraft: (update: (draft: string) => string) => void }
const voice = vi.hoisted(() => ({ target: null as Target | null }))
vi.mock('./voice/VoiceInputButton', () => ({
  VoiceInputButton: (props: { dictation?: Target }) => {
    voice.target = props.dictation ?? null
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
const { useComposerDraftStore } = await import('../../stores/composerDraft.store')
const { useLiveDictationStore } = await import('./voice/liveDictation.store')
const { startSpan } = await import('./voice/dictationSpan')

const KEY = 'dictation-test'
const controls = { freeze: vi.fn(), cancel: vi.fn(), send: vi.fn() }

// Reduced motion: the live words show at once instead of being typed out (useTypedText has its own test).
window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => {}, removeEventListener: () => {} })) as never

beforeEach(() => {
  useChatStore.getState().reset()
  useAuthStore.setState({ currentUser: null })
  useLiveDictationStore.setState({ live: {} })
  useComposerDraftStore.getState().update(KEY, () => ({ text: '' }))
  voice.target = null
  controls.freeze.mockReset()
  controls.cancel.mockReset()
  controls.send.mockReset()
})

function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function setDraft(text: string): void {
  act(() => useComposerDraftStore.getState().update(KEY, () => ({ text })))
}

function dictate(at: number, partial: string, length: number): void {
  act(() => useLiveDictationStore.getState().set(KEY, { span: startSpan(at, at, length), partial, finishing: false, controls }))
}

const textarea = (): HTMLTextAreaElement => screen.getByRole('combobox') as HTMLTextAreaElement

it('hands the voice button its own draft as the dictation target', () => {
  render(<ChatInput chatId="chat-1" draftKey={KEY} />, { wrapper })
  expect(voice.target?.draftKey).toBe(KEY)
  act(() => voice.target!.setDraft((draft) => `${draft}typed by voice`))
  expect(textarea().value).toBe('typed by voice')
})

it('shows the partial at the dictation, lighter, without writing it to the draft', () => {
  render(<ChatInput chatId="chat-1" draftKey={KEY} />, { wrapper })
  setDraft('Hello world')
  dictate(5, 'there', 11)
  expect(textarea().value).toBe('Hello there world')
  expect(textarea().dataset.dictating).toBe('')
  expect(document.querySelector('[data-dictation-partial]')?.textContent).toBe('there')
  expect(useComposerDraftStore.getState().drafts[KEY].text).toBe('Hello world')
  act(() => useLiveDictationStore.getState().set(KEY, null))
  expect(textarea().value).toBe('Hello world')
  expect(document.querySelector('[data-dictation-mirror]')).toBeNull()
})

it('a keystroke freezes the dictation and keeps the shown text plus the key', () => {
  render(<ChatInput chatId="chat-1" draftKey={KEY} />, { wrapper })
  setDraft('Hi')
  dictate(2, 'you', 2)
  fireEvent.change(textarea(), { target: { value: 'Hi you!' } })
  expect(controls.freeze).toHaveBeenCalledTimes(1)
  expect(useComposerDraftStore.getState().drafts[KEY].text).toBe('Hi you!')
})

it('Esc cancels and Enter sends through the dictation, not the composer', () => {
  render(<ChatInput chatId="chat-1" draftKey={KEY} />, { wrapper })
  setDraft('draft')
  dictate(5, 'more', 5)
  fireEvent.keyDown(textarea(), { key: 'Escape' })
  expect(controls.cancel).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(textarea(), { key: 'Enter' })
  expect(controls.send).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true })
  expect(controls.send).toHaveBeenCalledTimes(1)
})

it('Send counts the shown words, and a click on it sends through the dictation', () => {
  render(<ChatInput chatId="chat-1" draftKey={KEY} />, { wrapper })
  dictate(0, 'only spoken so far', 0)
  const send = screen.getByRole('button', { name: 'Send' })
  expect(send).toHaveProperty('disabled', false)
  fireEvent.click(send)
  expect(controls.send).toHaveBeenCalledTimes(1)
})
