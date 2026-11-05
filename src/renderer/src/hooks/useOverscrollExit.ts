import { useEffect, useRef, type RefObject } from 'react'

/**
 * Minimal view's second way out: with the transcript already at its bottom,
 * two separate scroll-down attempts close together end minimal view — the
 * user asking for more below than there is.
 *
 * An attempt is a run of downward wheel events with no gap of
 * `OVERSCROLL_ATTEMPT_GAP_MS` or more. It counts once its |deltaY| reaches
 * `OVERSCROLL_ATTEMPT_MIN_DELTA`, and only if it *began* at the bottom; the
 * scroll that reaches the bottom, and its momentum tail, never count. Two
 * counted attempts starting within `OVERSCROLL_WINDOW_MS` fire. An upward or
 * sideways wheel, or a counting attempt that began off the bottom, starts over.
 *
 * Tuned on recorded trackpad traces (the fixtures beside the test): momentum
 * events are at most 12 ms apart, the very end of a tail can show 16–34 ms
 * gaps but only with |deltaY| ≤ 3, and a second flick often starts during the
 * first one's momentum, 34–41 ms after its last event.
 */

/** A gap this long between wheel events begins a new attempt. */
export const OVERSCROLL_ATTEMPT_GAP_MS = 28
/** An attempt counts once one of its events moves at least this far (momentum-tail blips never do). */
export const OVERSCROLL_ATTEMPT_MIN_DELTA = 20
/** Two counted attempts must start within this long of each other. */
export const OVERSCROLL_WINDOW_MS = 1500
/** "At the bottom": within this many pixels of the end. */
export const OVERSCROLL_BOTTOM_SLACK_PX = 2

export interface OverscrollWheel {
  deltaX: number
  deltaY: number
  /** Milliseconds, any monotonic clock. */
  t: number
  /** The scroll container could not scroll further down when the event arrived. */
  atBottom: boolean
}

export interface OverscrollState {
  /** When the last wheel event arrived, or null. */
  lastT: number | null
  /** The attempt under way: when and where it began, its largest |deltaY|, and whether it has counted. */
  attempt: { start: number; atBottom: boolean; peak: number; counted: boolean } | null
  /** Start times of the counted attempts still inside the window. */
  counted: number[]
}

export const OVERSCROLL_INITIAL: OverscrollState = { lastT: null, attempt: null, counted: [] }

/** Whether a scroll container is at its bottom, from its geometry now. */
export function scrolledToBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - OVERSCROLL_BOTTOM_SLACK_PX
}

/**
 * Whether every scroll box between `target` and the transcript is at its own
 * bottom. A wheel over a tool result or thinking block scrolls that box first
 * and reaches the transcript only once it is exhausted, so until then it is
 * reading, not asking for more below.
 */
export function nestedScrollersAtBottom(target: Node, scroller: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : target.parentElement; el && el !== scroller; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + OVERSCROLL_BOTTOM_SLACK_PX) continue
    const overflowY = getComputedStyle(el).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && !scrolledToBottom(el)) return false
  }
  return true
}

/** One wheel event. Returns the next state and whether minimal view should end. */
export function overscrollStep(state: OverscrollState, wheel: OverscrollWheel): { state: OverscrollState; fired: boolean } {
  const abs = Math.abs(wheel.deltaY)
  if (wheel.deltaY < 0 || Math.abs(wheel.deltaX) > abs) {
    return { state: { lastT: wheel.t, attempt: null, counted: [] }, fired: false }
  }
  const gap = state.lastT === null ? Infinity : wheel.t - state.lastT
  let attempt = !state.attempt || gap >= OVERSCROLL_ATTEMPT_GAP_MS
    ? { start: wheel.t, atBottom: wheel.atBottom, peak: 0, counted: false }
    : state.attempt
  attempt = { ...attempt, peak: Math.max(attempt.peak, abs) }
  let counted = state.counted
  let fired = false
  if (!attempt.counted && attempt.peak >= OVERSCROLL_ATTEMPT_MIN_DELTA) {
    attempt = { ...attempt, counted: true }
    if (!attempt.atBottom) {
      counted = []
    } else {
      const start = attempt.start
      counted = [...counted.filter((at) => start - at <= OVERSCROLL_WINDOW_MS), start]
      if (counted.length >= 2) {
        fired = true
        counted = []
      }
    }
  }
  return { state: { lastT: wheel.t, attempt, counted }, fired }
}

/**
 * Watches wheel events over `ref`'s scroll container (the element under
 * `ref` marked `data-transcript-scroll`) and calls `onExit` on a double
 * overscroll at the bottom. Geometry is read at event time, before the
 * browser applies the scroll.
 */
export function useOverscrollExit(
  ref: RefObject<HTMLElement | null>,
  { enabled, onExit }: { enabled: boolean; onExit: () => void }
): void {
  const latest = useRef(onExit)
  latest.current = onExit

  useEffect(() => {
    const root = ref.current
    if (!enabled || !root) return
    let state = OVERSCROLL_INITIAL
    const wheel = (event: WheelEvent): void => {
      const scroller = root.querySelector<HTMLElement>('[data-transcript-scroll]')
      if (!scroller || !(event.target instanceof Node) || !scroller.contains(event.target)) return
      const step = overscrollStep(state, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        t: event.timeStamp,
        atBottom: scrolledToBottom(scroller) && nestedScrollersAtBottom(event.target, scroller)
      })
      state = step.state
      if (step.fired) latest.current()
    }
    root.addEventListener('wheel', wheel, { passive: true })
    return () => root.removeEventListener('wheel', wheel)
  }, [ref, enabled])
}
