import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isUnsettledClick, SETTLE_MS, useSettleGuard } from './useSettleGuard'

/**
 * The double-click guard: a view that just appeared ignores pointer clicks for
 * a moment, so the second click of the one that opened it cannot act on it.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useSettleGuard', () => {
  it('is settled on mount', () => {
    const { result } = renderHook(() => useSettleGuard('choose'))
    expect(result.current).toBe(true)
  })

  it('is unsettled right after the key changes, and settles after the delay', () => {
    const { result, rerender } = renderHook(({ k }) => useSettleGuard(k), {
      initialProps: { k: 'choose' }
    })
    rerender({ k: 'advanced' })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
  })

  it('restarts the delay when the key changes again before it settles', () => {
    const { result, rerender } = renderHook(({ k }) => useSettleGuard(k), {
      initialProps: { k: null as string | null }
    })
    rerender({ k: 'a' })
    act(() => vi.advanceTimersByTime(200))
    rerender({ k: 'b' })
    act(() => vi.advanceTimersByTime(200))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe(true)
  })

  it('stays unsettled when the key goes back to an earlier value inside the delay', () => {
    // Advanced options → Back → Advanced options again, quickly: the grid has
    // just reappeared, so the second click must still be ignored.
    const { result, rerender } = renderHook(({ k }) => useSettleGuard(k), {
      initialProps: { k: 'choose' }
    })
    rerender({ k: 'advanced' })
    act(() => vi.advanceTimersByTime(SETTLE_MS))
    rerender({ k: 'choose' })
    rerender({ k: 'advanced' })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(SETTLE_MS))
    expect(result.current).toBe(true)
  })
})

describe('isUnsettledClick', () => {
  it('ignores only pointer clicks, and only while unsettled', () => {
    expect(isUnsettledClick(false, { detail: 1 })).toBe(true)
    expect(isUnsettledClick(false, { detail: 2 })).toBe(true)
    // Enter / Space on a focused control.
    expect(isUnsettledClick(false, { detail: 0 })).toBe(false)
    expect(isUnsettledClick(true, { detail: 1 })).toBe(false)
  })
})
