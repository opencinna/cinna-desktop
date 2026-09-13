import { useEffect } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatTransition } from './ChatTransition'

let motion: EventTarget & { matches: boolean }
let animations: { cancel: ReturnType<typeof vi.fn>; finish: () => void }[]

beforeEach(() => {
  motion = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('matchMedia', () => motion)
  animations = []
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: vi.fn(() => {
      let finish!: () => void
      const finished = new Promise<void>((resolve) => { finish = resolve })
      const animation = { cancel: vi.fn(), finish, finished }
      animations.push(animation)
      return animation
    })
  })
})

afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function chat(id: string | null, enabled = true) {
  return (
    <ChatTransition chatId={id} enabled={enabled}>
      <div data-testid="transcript"><span>{id ?? 'New chat'}</span></div>
      <textarea id="composer" aria-label="Message" defaultValue="Draft" />
    </ChatTransition>
  )
}

it('shows the next chat immediately and preserves the outgoing scroll position in an inert snapshot', async () => {
  const { container, rerender } = render(chat('A'))
  expect(animations).toHaveLength(0)
  screen.getByTestId('transcript').scrollTop = 240
  const composer = screen.getByRole('textbox')
  composer.focus()
  rerender(chat('B'))
  const snapshot = container.querySelector('.chat-transition-snapshot') as HTMLElement
  expect(snapshot.querySelector('span')?.textContent).toBe('A')
  expect(snapshot.getAttribute('aria-hidden')).toBe('true')
  expect(snapshot.inert).toBe(true)
  expect(snapshot.querySelector('[data-testid="transcript"]')?.scrollTop).toBe(240)
  expect(container.querySelector('.chat-transition-content span')?.textContent).toBe('B')
  expect(container.querySelectorAll('#composer')).toHaveLength(1)
  expect(screen.getByRole('textbox')).toBe(composer)
  expect(document.activeElement).toBe(composer)

  await act(async () => { animations.forEach((animation) => animation.finish()) })
  expect(container.querySelector('.chat-transition-snapshot')).toBeNull()
})

it('replaces rapid switches without stale cleanup removing the latest transition', async () => {
  const { container, rerender, unmount } = render(chat('A'))
  rerender(chat('B'))
  const first = [...animations]
  rerender(chat(null))
  expect(first.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true)
  expect(container.querySelectorAll('.chat-transition-snapshot')).toHaveLength(1)
  expect(container.querySelector('.chat-transition-snapshot span')?.textContent).toBe('B')
  await act(async () => { first.forEach((animation) => animation.finish()) })
  expect(container.querySelector('.chat-transition-snapshot')).not.toBeNull()
  unmount()
  expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true)
})

it('skips disabled and reduced-motion transitions and cancels when either changes', () => {
  const { container, rerender } = render(chat('A', false))
  rerender(chat('B', false))
  expect(animations).toHaveLength(0)
  motion.matches = true
  rerender(chat('C'))
  expect(animations).toHaveLength(0)
  motion.matches = false
  rerender(chat('D'))
  expect(animations).toHaveLength(2)
  act(() => {
    motion.matches = true
    motion.dispatchEvent(new Event('change'))
  })
  expect(container.querySelector('.chat-transition-snapshot')).toBeNull()
  motion.matches = false
  rerender(chat('E'))
  rerender(chat('E', false))
  expect(container.querySelector('.chat-transition-snapshot')).toBeNull()
  expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true)
})

it('does not remount chat content or animate message updates within the same chat', () => {
  const mounted = vi.fn()
  function Content({ text }: { text: string }) {
    useEffect(mounted, [])
    return <p>{text}</p>
  }
  const { rerender } = render(<ChatTransition chatId="A" enabled><Content text="First" /></ChatTransition>)
  rerender(<ChatTransition chatId="A" enabled><Content text="Streaming update" /></ChatTransition>)
  expect(animations).toHaveLength(0)
  rerender(<ChatTransition chatId="B" enabled><Content text="Second" /></ChatTransition>)
  expect(animations).toHaveLength(2)
  expect(mounted).toHaveBeenCalledTimes(1)
})
