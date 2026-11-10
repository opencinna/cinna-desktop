import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTypedText } from './useTypedText'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  window.matchMedia = ((query: string) => ({ matches: false, media: query })) as never
})
afterEach(() => vi.useRealTimers())

function advance(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

it('types toward the target at a quick typist speed, not all at once', () => {
  const { result, rerender } = renderHook(({ target }) => useTypedText(target, true), { initialProps: { target: '' } })
  rerender({ target: 'Hello world' })
  advance(100)
  // About 45 characters a second: four or five after 100 ms.
  expect(result.current.length).toBeGreaterThan(2)
  expect(result.current.length).toBeLessThan(8)
  expect('Hello world'.startsWith(result.current)).toBe(true)
  advance(400)
  expect(result.current).toBe('Hello world')
})

it('backspaces a revision and retypes it', () => {
  const { result, rerender } = renderHook(({ target }) => useTypedText(target, true), { initialProps: { target: '' } })
  rerender({ target: "how's stream" })
  advance(1000)
  expect(result.current).toBe("how's stream")
  rerender({ target: 'how stream' })
  const seen = new Set<string>()
  for (let i = 0; i < 60; i++) {
    advance(16)
    seen.add(result.current)
  }
  // Backspaced at least back to where the two agree before retyping.
  expect([...seen].some((text) => text.length <= 'how '.length)).toBe(true)
  expect(result.current).toBe('how stream')
})

it('speeds up when far behind, so a long segment never lags by seconds', () => {
  const long = 'word '.repeat(60).trim()
  const { result, rerender } = renderHook(({ target }) => useTypedText(target, true), { initialProps: { target: '' } })
  rerender({ target: long })
  advance(900)
  expect(result.current).toBe(long)
})

it('swaps a revision far back in place instead of backspacing a paragraph', () => {
  const before = 'Lets check how streaming recognition be behaves in the composer and more'
  const after = "Let's check how streaming recognition behaves in the composer and more"
  const { result, rerender } = renderHook(({ target }) => useTypedText(target, true), { initialProps: { target: '' } })
  rerender({ target: before })
  advance(2000)
  rerender({ target: after })
  advance(16)
  expect(result.current.length).toBeGreaterThan(before.length - 10)
  advance(500)
  expect(result.current).toBe(after)
})

it('is the target itself when inactive, and starts from nothing on the next activation', () => {
  const { result, rerender } = renderHook(({ target, active }) => useTypedText(target, active), { initialProps: { target: 'kept', active: false } })
  expect(result.current).toBe('kept')
  rerender({ target: 'new', active: true })
  expect(result.current).toBe('')
  advance(200)
  expect(result.current).toBe('new')
})

it('shows the target at once with reduced motion', () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query })) as never
  const { result } = renderHook(() => useTypedText('all at once', true))
  expect(result.current).toBe('all at once')
})
