import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEAVY_AMBIENT_IDLE_MS, subscribeUserIdle as subscribe, useUserIdle } from './useUserIdle'

let focused = true
// A failed assertion must not leave a subscriber behind for the next test.
const subscriptions = new Set<() => void>()
const subscribeUserIdle = (thresholdMs: number, listener: (idle: boolean) => void): () => void => {
  const off = subscribe(thresholdMs, listener)
  const once = (): void => { if (subscriptions.delete(once)) off() }
  subscriptions.add(once)
  return once
}

beforeEach(() => {
  vi.useFakeTimers()
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
})

afterEach(() => {
  subscriptions.forEach((off) => off())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const blurWindow = (): void => { focused = false; fireEvent.blur(window) }
const focusWindow = (): void => { focused = true; fireEvent.focus(window) }

describe('user idle tracker', () => {
  it('turns idle after the threshold with no activity', () => {
    const { result, unmount } = renderHook(() => useUserIdle(1000))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(999))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
    unmount()
  })

  it.each([
    ['pointerdown', () => fireEvent.pointerDown(document.body)],
    ['keydown', () => fireEvent.keyDown(document.body)],
    ['wheel', () => fireEvent.wheel(document.body)],
    ['scroll', () => fireEvent.scroll(document.body)],
    ['input', () => fireEvent.input(document.body)],
    ['pointermove', () => fireEvent.pointerMove(document.body)]
  ])('%s anywhere ends idle and restarts the clock', (_name, fire) => {
    const { result, unmount } = renderHook(() => useUserIdle(1000))
    act(() => vi.advanceTimersByTime(600))
    act(() => fire())
    act(() => vi.advanceTimersByTime(600))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(400))
    expect(result.current).toBe(true)
    act(() => fire())
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(999))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
    unmount()
  })

  it('throttles pointermove but still ends idle on the first move', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeUserIdle(1000, listener)
    act(() => vi.advanceTimersByTime(1000))
    expect(listener).toHaveBeenLastCalledWith(true)
    fireEvent.pointerMove(document.body)
    expect(listener).toHaveBeenLastCalledWith(false)
    // Moves within the throttle window do not move the clock.
    act(() => vi.advanceTimersByTime(100))
    fireEvent.pointerMove(document.body)
    act(() => vi.advanceTimersByTime(900))
    expect(listener).toHaveBeenLastCalledWith(true)
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
  })

  it('is never idle while the window is blurred or hidden, and restarts the clock on return', () => {
    const { result, unmount } = renderHook(() => useUserIdle(1000))
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(true)
    act(() => blurWindow())
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current).toBe(false)
    act(() => focusWindow())
    act(() => vi.advanceTimersByTime(999))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)

    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current).toBe(false)
    hidden.mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current).toBe(true)
    unmount()
  })

  it('is never idle while focus is inside an iframe (a dashboard tile), whose events never reach the window', () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const active = vi.spyOn(document, 'activeElement', 'get')
    try {
      // Focus went into the frame without an event the window saw: the timer
      // firing re-checks and does not call it idle.
      const { result, unmount } = renderHook(() => useUserIdle(1000))
      active.mockReturnValue(frame)
      act(() => vi.advanceTimersByTime(5000))
      expect(result.current).toBe(false)

      // Back in the app: the clock restarts from the return.
      active.mockReturnValue(document.body)
      act(() => focusWindow())
      act(() => vi.advanceTimersByTime(999))
      expect(result.current).toBe(false)
      act(() => vi.advanceTimersByTime(1))
      expect(result.current).toBe(true)

      // Already idle, focus moves into the frame (the window blurs while it
      // still has focus): idle ends at once, and stays off.
      active.mockReturnValue(frame)
      act(() => { fireEvent.blur(window) })
      expect(result.current).toBe(false)
      act(() => vi.advanceTimersByTime(5000))
      expect(result.current).toBe(false)

      // A focusin on the app's own document brings it back.
      active.mockReturnValue(document.body)
      act(() => { fireEvent.focusIn(document.body) })
      act(() => vi.advanceTimersByTime(1000))
      expect(result.current).toBe(true)
      unmount()
    } finally {
      frame.remove()
    }
  })

  it('shares one set of window listeners and removes them with the last subscriber', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const a = subscribeUserIdle(1000, vi.fn())
    const b = subscribeUserIdle(HEAVY_AMBIENT_IDLE_MS, vi.fn())
    const added = add.mock.calls.filter(([type]) => type === 'pointermove')
    expect(added).toHaveLength(1)
    a()
    expect(remove.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(0)
    b()
    expect(remove.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serves different thresholds from one clock', () => {
    const short = vi.fn()
    const long = vi.fn()
    const offShort = subscribeUserIdle(1000, short)
    const offLong = subscribeUserIdle(3000, long)
    act(() => vi.advanceTimersByTime(1000))
    expect(short).toHaveBeenLastCalledWith(true)
    expect(long).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2000))
    expect(long).toHaveBeenLastCalledWith(true)
    offShort()
    offLong()
  })
})
