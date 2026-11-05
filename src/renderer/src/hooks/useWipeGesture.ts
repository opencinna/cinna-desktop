import { useEffect, useRef } from 'react'

/**
 * The wipe gesture that enters minimal view: the pointer swept back and forth
 * across the composer's text input, as if wiping it off the screen. Hover,
 * not drag — a drag over the textarea selects text — so a move with a button
 * held does not count.
 *
 * Every counted stroke has to pass through the input area (a point in it, or
 * a jump between two moves that crosses it); beyond that it may overshoot
 * over the transcript and out of the window (real wipes swing well above the
 * composer and past the window's bottom edge, which is just a gap between
 * moves). Wiping over the transcript alone never fires.
 *
 * The path is split into strokes at horizontal reversals, with hysteresis so
 * jitter is not a reversal. A stroke counts when it heads up-right or
 * down-left (flat tolerated), is not near-vertical, touched the input and is
 * long enough. A stroke too short to count is noise and skipped — a wiggle at
 * a turn does not break the run; a long stroke that fails does. Six counted,
 * alternating strokes inside the window fire it.
 *
 * Tuned on recorded real wipes (the fixture beside the test): strokes are
 * ~45° diagonals, the shorter ones only 80–90 px wide.
 */

/** A stroke shorter than this horizontally is noise: skipped, not counted, not a break. */
export const WIPE_MIN_STROKE_PX = 55
/** How far the pointer must come back from a stroke's far end before it counts as a reversal. */
export const WIPE_REVERSAL_HYSTERESIS_PX = 12
/** Steep diagonals count; a stroke steeper than this (|dy| / |dx|, about 63°) does not. */
export const WIPE_MAX_VERTICAL_RATIO = 2
/** "Flat tolerated": a stroke may lean the wrong way by this share of its horizontal travel. */
export const WIPE_FLAT_TOLERANCE_RATIO = 0.1
/** Six alternating strokes: three wipes. */
export const WIPE_STROKES_TO_FIRE = 6
/** From the first counted stroke's start to the last one's end. */
export const WIPE_WINDOW_MS = 1500
/** A gap longer than this between two moves (a pause, or long enough outside the window) starts over. */
export const WIPE_MAX_PAUSE_MS = 500

export interface WipePoint {
  x: number
  y: number
  /** Milliseconds, any monotonic clock. */
  t: number
}

/** The input area, in the same coordinates as the points. */
export interface WipeRect {
  x: number
  y: number
  width: number
  height: number
}

interface Stroke {
  start: WipePoint
  end: WipePoint
  /** Whether the stroke's path passed through the input area. */
  touched: boolean
}

export interface WipeState {
  /** Counted strokes in an unbroken run, oldest first, alternating in direction. */
  chain: Stroke[]
  /**
   * The stroke in progress: where it began, its far end so far, its direction
   * (0 until it has one), whether it touched the input up to its far end, and
   * whether the moves since the far end did (they open the next stroke if
   * this one turns out to have ended there).
   */
  current: { start: WipePoint; extreme: WipePoint; dir: -1 | 0 | 1; touched: boolean; touchedSinceExtreme: boolean } | null
  last: WipePoint | null
}

export const WIPE_INITIAL: WipeState = { chain: [], current: null, last: null }

/** Whether the segment from `a` to `b` (a single point when equal) meets `rect` (Liang–Barsky). */
export function segmentTouches(a: WipePoint, b: WipePoint, rect: WipeRect | null): boolean {
  if (!rect) return false
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const edges: [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y]
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      t0 = Math.max(t0, t)
    } else {
      if (t < t0) return false
      t1 = Math.min(t1, t)
    }
  }
  return true
}

/**
 * What one finished stroke is: `short` (noise, skipped), `bad` (long, but it
 * missed the input, is near-vertical or the wrong diagonal: breaks the run)
 * or `counts`. Screen y grows downward, so "up-right" is dx > 0, dy ≤ 0.
 */
export function classifyStroke(start: WipePoint, end: WipePoint, touched = true): 'short' | 'bad' | 'counts' {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const run = Math.abs(dx)
  if (run < WIPE_MIN_STROKE_PX) return 'short'
  if (!touched) return 'bad'
  if (Math.abs(dy) > run * WIPE_MAX_VERTICAL_RATIO) return 'bad'
  const flat = run * WIPE_FLAT_TOLERANCE_RATIO
  return (dx > 0 ? dy <= flat : dy >= -flat) ? 'counts' : 'bad'
}

/**
 * A finished stroke onto the run. One heading the same way as the last
 * counted stroke (only noise between them) extends it, so strokes stay
 * alternating.
 */
function addStroke(chain: Stroke[], stroke: Stroke): Stroke[] {
  const kind = classifyStroke(stroke.start, stroke.end, stroke.touched)
  if (kind === 'short') return chain
  if (kind === 'bad') return []
  const last = chain[chain.length - 1]
  if (last && (last.end.x - last.start.x) * (stroke.end.x - stroke.start.x) > 0) {
    return [...chain.slice(0, -1), { start: last.start, end: stroke.end, touched: true }]
  }
  return [...chain, stroke]
}

function fires(chain: Stroke[]): boolean {
  if (chain.length < WIPE_STROKES_TO_FIRE) return false
  const run = chain.slice(-WIPE_STROKES_TO_FIRE)
  return run[run.length - 1].end.t - run[0].start.t <= WIPE_WINDOW_MS
}

/**
 * One pointer move. `input` is the input area now (null: no input, nothing
 * counts). Returns the next state and whether the gesture fired; a fired
 * gesture starts over.
 */
export function wipeStep(state: WipeState, point: WipePoint, input: WipeRect | null): { state: WipeState; fired: boolean } {
  if (state.last && point.t - state.last.t > WIPE_MAX_PAUSE_MS) state = WIPE_INITIAL
  // A move that jumps across the input touches it as much as one that lands in it.
  const hit = segmentTouches(state.last ?? point, point, input)
  let chain = state.chain
  let current = state.current
  if (!current) {
    current = { start: point, extreme: point, dir: 0, touched: hit, touchedSinceExtreme: false }
  } else if (current.dir === 0) {
    const dx = point.x - current.start.x
    current = Math.abs(dx) >= WIPE_REVERSAL_HYSTERESIS_PX
      ? { ...current, extreme: point, dir: dx > 0 ? 1 : -1, touched: current.touched || hit }
      : { ...current, touched: current.touched || hit }
  } else {
    const dir = current.dir
    if ((point.x - current.extreme.x) * dir >= 0) {
      // Further on: whatever the back-and-forth since the far end touched is this stroke's.
      current = { ...current, extreme: point, touched: current.touched || current.touchedSinceExtreme || hit, touchedSinceExtreme: false }
    } else if ((current.extreme.x - point.x) * dir >= WIPE_REVERSAL_HYSTERESIS_PX) {
      // A reversal ends the stroke at its far end; the next one starts there.
      chain = addStroke(chain, { start: current.start, end: current.extreme, touched: current.touched })
      current = { start: current.extreme, extreme: point, dir: dir > 0 ? -1 : 1, touched: current.touchedSinceExtreme || hit, touchedSinceExtreme: false }
    } else {
      current = { ...current, touchedSinceExtreme: current.touchedSinceExtreme || hit }
    }
  }
  // The last stroke need not turn back: it fires as soon as it counts.
  const withCurrent = current.dir !== 0 && classifyStroke(current.start, current.extreme, current.touched) === 'counts'
    ? addStroke(chain, { start: current.start, end: current.extreme, touched: current.touched })
    : chain
  if (fires(withCurrent)) return { state: WIPE_INITIAL, fired: true }
  // Only the strokes that can still be part of a firing run are kept.
  if (chain.length >= WIPE_STROKES_TO_FIRE) chain = chain.slice(-(WIPE_STROKES_TO_FIRE - 1))
  return { state: { chain, current, last: point }, fired: false }
}

/**
 * Watches pointer moves anywhere in the window and calls `onWipe` when the
 * gesture fires; `getInput` gives the input area's rect, read on each move.
 * Starts over on any key, on a pressed button, on touch, and whenever
 * `isBlocked` says so (a composer popup open, voice recording).
 */
export function useWipeGesture(
  { enabled, getInput, isBlocked, onWipe }: {
    enabled: boolean
    getInput: () => WipeRect | null
    isBlocked: () => boolean
    onWipe: () => void
  }
): void {
  const latest = useRef({ getInput, isBlocked, onWipe })
  latest.current = { getInput, isBlocked, onWipe }

  useEffect(() => {
    if (!enabled) return
    let state = WIPE_INITIAL
    const reset = (): void => { state = WIPE_INITIAL }
    const move = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || event.buttons !== 0 || latest.current.isBlocked()) {
        reset()
        return
      }
      const step = wipeStep(state, { x: event.clientX, y: event.clientY, t: event.timeStamp }, latest.current.getInput())
      state = step.state
      if (step.fired) latest.current.onWipe()
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('keydown', reset, true)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('keydown', reset, true)
    }
  }, [enabled])
}
