import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  nestedScrollersAtBottom,
  OVERSCROLL_ATTEMPT_GAP_MS,
  OVERSCROLL_INITIAL,
  OVERSCROLL_WINDOW_MS,
  overscrollStep,
  scrolledToBottom,
  useOverscrollExit,
  type OverscrollWheel
} from './useOverscrollExit'

type Wheel = Omit<OverscrollWheel, 'deltaX'> & { deltaX?: number }

function run(wheels: Wheel[]): number {
  let state = OVERSCROLL_INITIAL
  let fired = 0
  for (const wheel of wheels) {
    const step = overscrollStep(state, { deltaX: 0, ...wheel })
    state = step.state
    if (step.fired) fired++
  }
  return fired
}

/** A mouse-wheel burst: `count` events of 100 px, 10 ms apart (one spin of the wheel). */
function notches(t0: number, atBottom: boolean | ((index: number) => boolean), count = 3): Wheel[] {
  return Array.from({ length: count }, (_, i) => ({
    deltaY: 100,
    t: t0 + i * 10,
    atBottom: typeof atBottom === 'function' ? atBottom(i) : atBottom
  }))
}

/**
 * A trackpad flick: a short rise, then a decaying momentum tail, 16 ms apart.
 * `atBottom(i)` says where the transcript stands at each event.
 */
function flick(t0: number, atBottom: (index: number) => boolean, length = 60): Wheel[] {
  const deltas = [6, 18, 40, 52]
  let delta = 52
  while (deltas.length < length) {
    delta *= 0.93
    deltas.push(Math.max(1, Math.round(delta)))
  }
  return deltas.map((deltaY, i) => ({ deltaY, t: t0 + i * 16, atBottom: atBottom(i) }))
}

interface Trace { events: { t: number; dy: number; dx: number; bottom: boolean }[] }
const trace = (name: string): Trace =>
  JSON.parse(readFileSync(resolve(process.cwd(), `src/renderer/src/hooks/useOverscrollExit.${name}.json`), 'utf8'))

/** Where a recorded trace fires, in ms from its first event. */
function firesIn({ events }: Trace): number[] {
  const t0 = events[0].t
  let state = OVERSCROLL_INITIAL
  const firedAt: number[] = []
  for (const event of events) {
    const step = overscrollStep(state, { deltaX: event.dx, deltaY: event.dy, t: event.t, atBottom: event.bottom })
    state = step.state
    if (step.fired) firedAt.push(event.t - t0)
  }
  return firedAt
}

/** Each fire within ±40 ms of where it is expected, and no other fire. */
function expectFiresNear(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((at, i) => expect(Math.abs(at - expected[i])).toBeLessThanOrEqual(40))
}

describe('recorded trackpad traces', () => {
  it('take a: two double flicks fire twice, at their second flicks', () => {
    expectFiresNear(firesIn(trace('trace_a')), [421, 1951])
  })

  it('take b: eight double flicks, second flicks often inside the first one\'s momentum, fire eight times', () => {
    expectFiresNear(firesIn(trace('trace_b')), [449, 2221, 3876, 5394, 7399, 9801, 11949, 14258])
  })

  it('take c: fires four times, where the tuner did, and nowhere else', () => {
    expectFiresNear(firesIn(trace('trace_c')), [352, 6794, 11027, 18547])
  })
})

describe('double overscroll classifier', () => {
  it('fires on two mouse-wheel bursts at the bottom', () => {
    expect(run([...notches(1000, true), ...notches(1400, true)])).toBe(1)
  })

  it('fires on two trackpad flicks at the bottom, the second inside the first one\'s momentum', () => {
    const first = flick(1000, () => true, 30)
    const second = flick(first[first.length - 1].t + OVERSCROLL_ATTEMPT_GAP_MS + 8, () => true, 20)
    expect(run([...first, ...second])).toBe(1)
  })

  it('does not fire on a single flick at the bottom, however its deltas jitter', () => {
    expect(run(flick(1000, () => true, 60))).toBe(0)
    // Doubled frames: 1 → 8, 5 → 35, 40 → 82, 17 ms apart, then a tail with late blips.
    const jittery = [1, 8, 5, 35, 40, 82, 30, 12, 6, 3].map((deltaY, i) => ({ deltaY, t: 1000 + i * 17, atBottom: true }))
    const blips = [3, 2, 1].map((deltaY, i) => ({ deltaY, t: 1000 + 9 * 17 + (i + 1) * 34, atBottom: true }))
    expect(run([...jittery, ...blips])).toBe(0)
  })

  it('does not fire on one long trackpad fling into the bottom and its momentum', () => {
    expect(run(flick(1000, (i) => i > 20, 90))).toBe(0)
  })

  it('does not count the fling that reaches the bottom: one more flick is only the first', () => {
    const fling = flick(1000, (i) => i > 20, 40)
    const end = fling[fling.length - 1].t
    expect(run([...fling, ...flick(end + 200, () => true, 20)])).toBe(0)
    // A burst of notches that reaches the bottom on its last notch, then one more burst.
    expect(run([...notches(1000, (i) => i === 2), ...notches(1300, true)])).toBe(0)
  })

  it('does not fire on two attempts further apart than the window', () => {
    expect(run([...notches(1000, true), ...notches(1000 + OVERSCROLL_WINDOW_MS + 200, true)])).toBe(0)
  })

  it('starts over on an upward or sideways wheel in between', () => {
    expect(run([...notches(1000, true), { deltaY: -40, t: 1200, atBottom: true }, ...notches(1400, true)])).toBe(0)
    expect(run([...notches(1000, true), { deltaY: 5, deltaX: 60, t: 1200, atBottom: true }, ...notches(1400, true)])).toBe(0)
  })

  it('does not fire away from the bottom', () => {
    expect(run([...notches(1000, false), ...notches(1400, false), ...notches(1800, false)])).toBe(0)
    // An attempt off the bottom in between starts over.
    expect(run([...notches(1000, true), ...notches(1300, false), ...notches(1600, true)])).toBe(0)
  })

  it('reads the bottom from the geometry', () => {
    expect(scrolledToBottom({ scrollTop: 498, clientHeight: 500, scrollHeight: 1000 })).toBe(true)
    expect(scrolledToBottom({ scrollTop: 490, clientHeight: 500, scrollHeight: 1000 })).toBe(false)
  })
})

describe('useOverscrollExit', () => {
  function setup(enabled = true): { scroller: HTMLDivElement; other: HTMLDivElement; onExit: ReturnType<typeof vi.fn>; wheel: (target: Element, t: number) => void } {
    document.body.innerHTML = ''
    const root = document.createElement('div')
    const scroller = document.createElement('div')
    scroller.setAttribute('data-transcript-scroll', '')
    const other = document.createElement('div')
    root.append(scroller, other)
    document.body.append(root)
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 500, configurable: true }
    })
    scroller.scrollTop = 500
    const onExit = vi.fn()
    renderHook(() => useOverscrollExit({ current: root }, { enabled, onExit }))
    const wheel = (target: Element, t: number): void => {
      const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true })
      Object.defineProperty(event, 'timeStamp', { value: t })
      target.dispatchEvent(event)
    }
    return { scroller, other, onExit, wheel }
  }

  it('ends minimal view on two wheel attempts over the transcript at its bottom', () => {
    const { scroller, onExit, wheel } = setup()
    wheel(scroller, 1000)
    wheel(scroller, 1400)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('ignores wheels outside the transcript, off its bottom, or while not in minimal view', () => {
    const outside = setup()
    outside.wheel(outside.other, 1000)
    outside.wheel(outside.other, 1400)
    expect(outside.onExit).not.toHaveBeenCalled()

    const offBottom = setup()
    offBottom.scroller.scrollTop = 100
    offBottom.wheel(offBottom.scroller, 1000)
    offBottom.wheel(offBottom.scroller, 1400)
    expect(offBottom.onExit).not.toHaveBeenCalled()

    const off = setup(false)
    off.wheel(off.scroller, 1000)
    off.wheel(off.scroller, 1400)
    expect(off.onExit).not.toHaveBeenCalled()
  })

  it('treats a nested scroll box that is not at its own bottom as reading, not overscroll', () => {
    const scroller = document.createElement('div')
    const inner = document.createElement('div')
    const leaf = document.createElement('span')
    inner.appendChild(leaf)
    scroller.appendChild(inner)
    document.body.appendChild(scroller)
    inner.style.overflowY = 'auto'
    const geometry = (el: HTMLElement, top: number, client: number, height: number): void => {
      Object.defineProperty(el, 'scrollTop', { value: top, configurable: true, writable: true })
      Object.defineProperty(el, 'clientHeight', { value: client, configurable: true })
      Object.defineProperty(el, 'scrollHeight', { value: height, configurable: true })
    }
    geometry(inner, 0, 100, 400)
    expect(nestedScrollersAtBottom(leaf, scroller)).toBe(false)
    inner.scrollTop = 300
    expect(nestedScrollersAtBottom(leaf, scroller)).toBe(true)
    // A box with nothing to scroll never holds the gesture back.
    geometry(inner, 0, 100, 100)
    expect(nestedScrollersAtBottom(leaf, scroller)).toBe(true)
    scroller.remove()
  })
})
