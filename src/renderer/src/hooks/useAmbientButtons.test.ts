import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAmbientButtons } from './useAmbientButtons'

vi.mock('../stores/ui.store', () => ({
  useUIStore: (selector: (state: { extraUIAnimation: boolean }) => unknown) => selector({ extraUIAnimation: true })
}))

let composer: HTMLDivElement
let input: HTMLTextAreaElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 600, height: 100, top: 0, right: 600, bottom: 100, left: 0, toJSON: () => ({})
  })
  HTMLElement.prototype.checkVisibility = () => true
  document.elementFromPoint = () => input
  composer = document.createElement('div')
  composer.className = 'ambient-button'
  composer.setAttribute('data-ambient-card', '')
  input = document.createElement('textarea')
  composer.append(input)
  document.body.append(composer)
})

afterEach(() => {
  composer.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useAmbientButtons with the chat composer', () => {
  it('glows a focused composer nobody is typing in', () => {
    input.focus()
    renderHook(() => useAmbientButtons())
    act(() => vi.advanceTimersByTime(4000))
    expect(composer.hasAttribute('data-ambient-glow')).toBe(true)
  })

  it('drops a running glow on the first keystroke and skips the composer while typing', () => {
    input.focus()
    renderHook(() => useAmbientButtons())
    act(() => vi.advanceTimersByTime(4000))
    expect(composer.hasAttribute('data-ambient-glow')).toBe(true)

    fireEvent.keyDown(input)
    expect(composer.hasAttribute('data-ambient-glow')).toBe(false)
    // The next turn comes 8s later; keep typing until just before it.
    act(() => vi.advanceTimersByTime(7000))
    fireEvent.keyDown(input)
    act(() => vi.advanceTimersByTime(1000))
    expect(composer.hasAttribute('data-ambient-glow')).toBe(false)

    // Once typing stops, a later turn may land on it again.
    act(() => vi.advanceTimersByTime(4000))
    act(() => vi.advanceTimersByTime(8000))
    expect(composer.hasAttribute('data-ambient-glow')).toBe(true)
  })
})
