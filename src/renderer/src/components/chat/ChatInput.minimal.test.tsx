import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useState, type ReactNode } from 'react'

/**
 * Minimal view's cloud is the same composer restyled: switching presentation
 * keeps the textarea node (focus, selection, IME), hides the toolbar without
 * unmounting it, and shows the cloud only while the draft has content.
 */

function namespace() {
  return new Proxy({}, { get: (_target, method: string) => method.startsWith('on') ? () => () => {} : async () => [] })
}
window.api = new Proxy({}, { get: () => namespace() }) as never
const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')
const { useAuthStore } = await import('../../stores/auth.store')
const { useComposerDraftStore, composerDraftKey } = await import('../../stores/composerDraft.store')

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
function wrapper({ children }: { children: ReactNode }) {
  const [c] = useState(() => client)
  return <QueryClientProvider client={c}>{children}</QueryClientProvider>
}

beforeEach(() => {
  useChatStore.getState().reset()
  useComposerDraftStore.setState({ drafts: {} })
  useAuthStore.setState({ currentUser: { id: 'u1', type: 'cinna_user' } as never })
})

describe('the cloud presentation', () => {
  it('keeps the same textarea, its focus and its selection when switching in and out', () => {
    const view = render(<ChatInput chatId={null} />, { wrapper })
    const box = screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'hello world' } })
    box.focus()
    box.setSelectionRange(2, 5)
    view.rerender(<ChatInput chatId={null} minimal />)
    expect(screen.getByRole('combobox')).toBe(box)
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([2, 5])
    expect(screen.getByTestId('minimal-cloud')).toBeTruthy()
    view.rerender(<ChatInput chatId={null} />)
    expect(screen.getByRole('combobox')).toBe(box)
    expect(document.activeElement).toBe(box)
    expect(box.value).toBe('hello world')
    expect(screen.queryByTestId('minimal-cloud')).toBeNull()
  })

  it('hides the toolbar row without unmounting it', () => {
    const view = render(<ChatInput chatId={null} />, { wrapper })
    const send = screen.getByRole('button', { name: 'Send' })
    view.rerender(<ChatInput chatId={null} minimal />)
    expect(screen.getByRole('button', { name: 'Send', hidden: true })).toBe(send)
    expect(send.closest('.hidden')).not.toBeNull()
    view.rerender(<ChatInput chatId={null} />)
    expect(send.closest('.hidden')).toBeNull()
  })

  it('is invisible while the draft is empty or whitespace, and shows with text', () => {
    render(<ChatInput chatId={null} minimal />, { wrapper })
    const cloud = screen.getByTestId('minimal-cloud')
    const box = screen.getByRole('combobox')
    expect(cloud.hasAttribute('data-cloud-empty')).toBe(true)
    fireEvent.change(box, { target: { value: '   ' } })
    expect(cloud.hasAttribute('data-cloud-empty')).toBe(true)
    fireEvent.change(box, { target: { value: 'hi' } })
    expect(cloud.hasAttribute('data-cloud-empty')).toBe(false)
    fireEvent.change(box, { target: { value: '' } })
    expect(cloud.hasAttribute('data-cloud-empty')).toBe(true)
    // Never inert: an empty cloud still takes focus and typing.
    expect(box.closest('[inert]')).toBeNull()
  })

  it('shows for a paste chip alone', () => {
    const key = composerDraftKey('u1', 'minimal-test')
    useComposerDraftStore.getState().update(key, () => ({ pastes: [{ id: 'p1', text: 'x'.repeat(2000) }] }))
    render(<ChatInput chatId={null} draftKey={key} minimal />, { wrapper })
    expect(screen.getByTestId('minimal-cloud').hasAttribute('data-cloud-empty')).toBe(false)
  })
})
