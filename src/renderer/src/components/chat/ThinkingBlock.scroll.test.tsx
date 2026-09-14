vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThinkingBlock } from './ThinkingBlock'

/** jsdom has no layout: give the body the geometry of a box with more thinking than fits. */
function geometry(el: HTMLElement, box: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => box.scrollTop, set: (value: number) => { box.scrollTop = value } })
}

describe('a thinking block', () => {
  it('caps its body at about twelve lines with a scroll of its own', () => {
    const { container } = render(<ThinkingBlock content="thinking" defaultExpanded />)
    const body = container.querySelector<HTMLElement>('[data-thinking-body]')!
    expect(body.classList.contains('max-h-60')).toBe(true)
    expect(body.classList.contains('overflow-y-auto')).toBe(true)
  })

  it('follows new thinking while it streams, until the user scrolls it up, and again once back at the bottom', () => {
    const { container, rerender } = render(<ThinkingBlock content="one" isStreaming defaultExpanded />)
    const body = container.querySelector<HTMLElement>('[data-thinking-body]')!
    const box = { scrollHeight: 400, clientHeight: 240, scrollTop: 0 }
    geometry(body, box)

    rerender(<ThinkingBlock content="one two" isStreaming defaultExpanded />)
    expect(box.scrollTop).toBe(400)

    box.scrollTop = 50
    fireEvent.scroll(body)
    box.scrollHeight = 600
    rerender(<ThinkingBlock content="one two three" isStreaming defaultExpanded />)
    expect(box.scrollTop).toBe(50)

    box.scrollTop = 360
    fireEvent.scroll(body)
    box.scrollHeight = 800
    rerender(<ThinkingBlock content="one two three four" isStreaming defaultExpanded />)
    expect(box.scrollTop).toBe(800)
  })
})
