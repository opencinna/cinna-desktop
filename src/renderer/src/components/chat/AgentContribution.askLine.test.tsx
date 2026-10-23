import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AgentContribution } from './AgentContribution'

/** jsdom lays nothing out: make every element report `scroll` px of content in `client` px of box. */
function layout(scroll: number, client: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scroll)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(client)
}

/** jsdom has no CSS: give the box around the prompt the 200ms height transition it has in the app. */
function slidingBox(): void {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = real(el, pseudo)
    if (el.firstElementChild?.getAttribute('data-testid') !== 'agent-ask') return style
    return new Proxy(style, { get: (target, key) => (key === 'transitionDuration' ? '0.2s' : Reflect.get(target, key)) })
  })
}

afterEach(() => vi.restoreAllMocks())

describe('the ask line', () => {
  it('clamps a long prompt to two lines, with the rest behind Show more, below the text', () => {
    // Mutation: drop `line-clamp-2` → the whole prompt is a wall of text; drop the toggle → no way to read it.
    layout(120, 30)
    render(<AgentContribution parts={[]} askMessage={'Run the command.\n'.repeat(12)} />)
    const ask = screen.getByTestId('agent-ask')
    expect(ask.className).toContain('line-clamp-2')
    // Mutation: `block` beside the clamp → it wins in the built CSS and nothing is clamped.
    expect(ask.classList.contains('block')).toBe(false)
    const toggle = screen.getByRole('button', { name: 'Show more' })
    // Below the text, so opening it moves nothing above.
    expect(ask.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(toggle)
    expect(ask.className).not.toContain('line-clamp-2')
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the whole prompt shown until Show less has slid it down, then clamps it', () => {
    // Mutation: clamp on click instead of at the end of the slide → the text snaps to two lines, then the box shrinks under it.
    layout(120, 30)
    slidingBox()
    vi.useFakeTimers()
    try {
      render(<AgentContribution parts={[]} askMessage={'Run the command.\n'.repeat(12)} />)
      const ask = screen.getByTestId('agent-ask')
      const box = ask.parentElement as HTMLElement
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
      act(() => {
        box.dispatchEvent(new Event('transitionend'))
      })
      expect(box.style.height).toBe('')
      fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
      expect(screen.getByRole('button', { name: 'Show more' }).getAttribute('aria-expanded')).toBe('false')
      expect(ask.className).not.toContain('line-clamp-2')
      expect(box.style.height).toBe('30px')
      act(() => {
        box.dispatchEvent(new Event('transitionend'))
      })
      expect(ask.className).toContain('line-clamp-2')
      expect(box.style.height).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never leaves the box pinned when no transitionend arrives', () => {
    // Mutation: drop the fallback timer → a slide whose height does not change leaves the prompt unclamped for good.
    layout(120, 30)
    slidingBox()
    vi.useFakeTimers()
    try {
      render(<AgentContribution parts={[]} askMessage={'Run the command.\n'.repeat(12)} />)
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
      act(() => {
        vi.advanceTimersByTime(300)
      })
      fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(screen.getByTestId('agent-ask').className).toContain('line-clamp-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers no toggle for a prompt that fits', () => {
    layout(30, 30)
    render(<AgentContribution parts={[]} askMessage="Confirm pg" />)
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })
})
