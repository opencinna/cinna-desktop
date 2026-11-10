import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_HOLD_MS,
  MIN_HOLD_MS,
  REVEAL_MS,
  SETTLE_MS,
  resetStartupSplashForTests,
  skipStartupSplash,
  useStartupSplash
} from './useStartupSplash'

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const hook = renderHook(() => useStartupSplash(), { wrapper })
  return { client, ...hook }
}

/** The two frames between a visible window and the blocks' fade-in. */
function enter(): void {
  act(() => vi.advanceTimersByTime(40))
}

/** A query that stays in flight until `finish` is called. */
function holdQuery(client: QueryClient): () => void {
  let finish!: () => void
  void client.fetchQuery({ queryKey: ['slow'], queryFn: () => new Promise<string>((resolve) => { finish = () => resolve('ok') }) })
  return () => finish()
}

describe('useStartupSplash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStartupSplashForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds for the minimum when nothing is loading, then reveals and finishes', () => {
    const { result } = setup()
    expect(result.current).toBe('wait')
    enter()
    expect(result.current).toBe('hold')
    act(() => vi.advanceTimersByTime(MIN_HOLD_MS))
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1))
    expect(result.current).toBe('hold')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe('reveal')
    act(() => vi.advanceTimersByTime(REVEAL_MS))
    expect(result.current).toBe('done')
  })

  it('waits past the minimum for a query in flight, and reveals when it settles', async () => {
    const { client, result } = setup()
    const finish = holdQuery(client)
    enter()
    act(() => vi.advanceTimersByTime(MIN_HOLD_MS + 200))
    expect(result.current).toBe('hold')
    await act(async () => {
      finish()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
    })
    expect(result.current).toBe('reveal')
  })

  it('does not reveal while a query that starts as another settles is in flight', async () => {
    const { client, result } = setup()
    const finishFirst = holdQuery(client)
    enter()
    act(() => vi.advanceTimersByTime(MIN_HOLD_MS + 100))
    // The gap a dependent query leaves: the first settles and the hook renders
    // with nothing loading, then the second starts a moment later.
    await act(async () => {
      finishFirst()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current).toBe('hold')
    let finishSecond!: () => void
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
      void client.fetchQuery({ queryKey: ['next'], queryFn: () => new Promise<string>((resolve) => { finishSecond = () => resolve('ok') }) })
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
    })
    expect(result.current).toBe('hold')
    await act(async () => {
      finishSecond()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
    })
    expect(result.current).toBe('reveal')
  })

  it('reveals at the cap even when a query never settles', () => {
    const { client, result } = setup()
    holdQuery(client)
    enter()
    act(() => vi.advanceTimersByTime(MAX_HOLD_MS - 1))
    expect(result.current).toBe('hold')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe('reveal')
  })

  it('keeps everything transparent while the window is hidden, and fades the blocks in once it shows', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const { result } = setup()
      act(() => vi.advanceTimersByTime(MAX_HOLD_MS * 2))
      expect(result.current).toBe('wait')
      visibility.mockReturnValue('visible')
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      enter()
      expect(result.current).toBe('hold')
      act(() => vi.advanceTimersByTime(MIN_HOLD_MS - 1))
      expect(result.current).toBe('hold')
    } finally {
      visibility.mockRestore()
    }
  })

  it('reveals at once on a key press', () => {
    const { result } = setup()
    enter()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(result.current).toBe('reveal')
  })

  it('runs once per launch: a second shell mount starts done', () => {
    const first = setup()
    first.unmount()
    const { result } = setup()
    expect(result.current).toBe('done')
  })

  it('is skipped when the launch went through login or onboarding first', () => {
    skipStartupSplash()
    const { result } = setup()
    expect(result.current).toBe('done')
  })
})
