import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  WIPE_INITIAL,
  WIPE_MAX_PAUSE_MS,
  WIPE_MIN_STROKE_PX,
  WIPE_WINDOW_MS,
  classifyStroke,
  segmentTouches,
  useWipeGesture,
  wipeStep,
  type WipePoint,
  type WipeRect
} from './useWipeGesture'

interface Rect { x: number; y: number; w: number; h: number }
interface Take {
  name: string
  dock: Rect
  card: Rect
  events: { k: 'm' | 'enter' | 'leave'; x: number; y: number; t: number }[]
}

/**
 * Real wipes recorded by the user (x/y/t only): `card` is the composer's
 * input card, the dock its full-width strip at the window bottom.
 * `enter`/`leave` are the window's; the hook sees only moves, so a trip out of
 * the window is a gap.
 */
const TAKES: Take[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/renderer/src/hooks/useWipeGesture.traces.json'), 'utf8')
).takes

const cardOf = (take: Take): WipeRect => ({ x: take.card.x, y: take.card.y, width: take.card.w, height: take.card.h })

function takeMoves(take: Take, { dx = 1, dt = 1 } = {}): WipePoint[] {
  const moves = take.events.filter((event) => event.k === 'm')
  const x0 = moves[0].x
  const t0 = moves[0].t
  return moves.map((event) => ({ x: x0 + (event.x - x0) * dx, y: event.y, t: t0 + (event.t - t0) * dt }))
}

/** The synthetic composer input: 600 × 80 at (100, 400). */
const INPUT: WipeRect = { x: 100, y: 400, width: 600, height: 80 }

/**
 * A back-and-forth path: `strokes` strokes of `length` px, starting rightward,
 * `perStroke` ms each, sampled every 10 px. `rise` is the vertical travel of a
 * rightward stroke (negative is up); a leftward one travels the opposite way.
 * By default each stroke crosses `INPUT` through its middle.
 */
function wipePath({ strokes = 6, length = 200, perStroke = 150, rise = -150, x0 = 300, y0 = 515, t0 = 1000 } = {}): WipePoint[] {
  const points: WipePoint[] = [{ x: x0, y: y0, t: t0 }]
  let x = x0
  let y = y0
  let t = t0
  for (let s = 0; s < strokes; s++) {
    const dir = s % 2 === 0 ? 1 : -1
    const steps = Math.max(1, Math.round(length / 10))
    for (let i = 0; i < steps; i++) {
      x += (dir * length) / steps
      y += (dir * rise) / steps
      t += perStroke / steps
      points.push({ x, y, t })
    }
  }
  return points
}

function run(points: WipePoint[], input: WipeRect | null = INPUT): number {
  let state = WIPE_INITIAL
  let fired = 0
  for (const point of points) {
    const step = wipeStep(state, point, input)
    state = step.state
    if (step.fired) fired++
  }
  return fired
}

describe('recorded wipes', () => {
  it('has the four takes', () => {
    expect(TAKES.map((take) => take.name)).toEqual(['take_a0', 'take_a1', 'take_b0', 'take_c0'])
  })

  it.each(TAKES.map((take) => take.name))('%s fires', (name) => {
    const take = TAKES.find((entry) => entry.name === name)!
    expect(run(takeMoves(take), cardOf(take))).toBe(1)
  })

  it.each(TAKES.map((take) => take.name))('%s still fires 15%% narrower and 15%% slower', (name) => {
    const take = TAKES.find((entry) => entry.name === name)!
    expect(run(takeMoves(take, { dx: 0.85, dt: 1.15 }), cardOf(take))).toBe(1)
  })

  it.each(TAKES.map((take) => take.name))('%s does not fire with its sixth stroke cut off', (name) => {
    const take = TAKES.find((entry) => entry.name === name)!
    const moves = takeMoves(take)
    // Where it fires, then back to the turn that began that (sixth) stroke.
    let state = WIPE_INITIAL
    let firedAt = -1
    moves.forEach((point, index) => {
      const step = wipeStep(state, point, cardOf(take))
      state = step.state
      if (step.fired && firedAt < 0) firedAt = index
    })
    const dir = Math.sign(moves[firedAt].x - moves[firedAt - 1].x)
    let turn = firedAt
    while (turn > 0 && Math.sign(moves[turn].x - moves[turn - 1].x) !== -dir) turn--
    expect(run(moves.slice(0, turn), cardOf(take))).toBe(0)
  })

  it('does not fire when the same moves stay entirely above the input card', () => {
    for (const take of TAKES) {
      const card = cardOf(take)
      const above = takeMoves(take).map((move) => ({ ...move, y: Math.min(move.y, card.y - 1) - 200 }))
      expect(run(above, card)).toBe(0)
    }
  })

  it('does not fire without an input to cross', () => {
    for (const take of TAKES) expect(run(takeMoves(take), null)).toBe(0)
  })
})

describe('wipe classifier', () => {
  it('fires on three brisk diagonal wipes over the composer, flat ones too', () => {
    expect(run(wipePath())).toBe(1)
    expect(run(wipePath({ rise: 0, y0: 440 }))).toBe(1)
  })

  it('does not fire on five strokes', () => {
    expect(run(wipePath({ strokes: 5 }))).toBe(0)
  })

  it('lets strokes overshoot the input, as long as each crosses it', () => {
    // 300 px tall diagonals centred on the input: most of each is above or below it.
    expect(run(wipePath({ rise: -300, length: 240 }))).toBe(1)
  })

  it('counts a fast move that jumps across the input without landing in it', () => {
    expect(segmentTouches({ x: 300, y: 300, t: 0 }, { x: 340, y: 600, t: 1 }, INPUT)).toBe(true)
    expect(segmentTouches({ x: 300, y: 300, t: 0 }, { x: 340, y: 390, t: 1 }, INPUT)).toBe(false)
    // Two samples per stroke, each on the far side of the input.
    const jumpy: WipePoint[] = []
    for (let s = 0; s <= 6; s++) jumpy.push({ x: s % 2 === 0 ? 250 : 450, y: s % 2 === 0 ? 560 : 320, t: 1000 + s * 120 })
    expect(run(jumpy)).toBe(1)
  })

  it('does not fire on wipes over the transcript alone', () => {
    // The same wipe, 200 px above the input.
    expect(run(wipePath({ y0: 315 }))).toBe(0)
  })

  it('a long stroke that misses the input breaks the run', () => {
    const first = wipePath({ strokes: 3, perStroke: 120 })
    const end = first[first.length - 1]
    // Leftward, but entirely above the input; then three good strokes.
    const miss: WipePoint[] = [{ x: end.x - 40, y: 300, t: end.t + 30 }, { x: end.x - 200, y: 350, t: end.t + 120 }]
    // The next stroke turns right at once, down into the input.
    const back = wipePath({ strokes: 3, perStroke: 120, x0: end.x - 180, y0: 515, t0: end.t + 160 })
    expect(run([...first, ...miss, ...back])).toBe(0)
    // The same leftward stroke through the input keeps the run going.
    const through: WipePoint[] = [{ x: end.x - 40, y: 400, t: end.t + 30 }, { x: end.x - 200, y: 515, t: end.t + 120 }]
    expect(run([...first, ...through, ...back])).toBe(1)
  })

  it('does not fire on a single long reach to Send', () => {
    expect(run(wipePath({ strokes: 1, length: 600, rise: 60 }))).toBe(0)
    expect(run(wipePath({ strokes: 1, length: 600, rise: -300 }))).toBe(0)
  })

  it('does not fire on slow drift while reading', () => {
    // Back and forth across lines, half a second per sweep.
    expect(run(wipePath({ strokes: 10, length: 300, perStroke: 450, rise: -20 }))).toBe(0)
  })

  it('does not fire on a vertical zigzag', () => {
    expect(run(wipePath({ strokes: 8, length: 60, rise: -200 }))).toBe(0)
    expect(classifyStroke({ x: 0, y: 0, t: 0 }, { x: 80, y: -200, t: 1 })).toBe('bad')
  })

  it('does not fire on six steep strokes spread over three seconds', () => {
    expect(run(wipePath({ perStroke: 3000 / 6, rise: -150 }))).toBe(0)
  })

  it('does not fire on tiny wiggles only', () => {
    expect(run(wipePath({ strokes: 20, length: 40, perStroke: 60, rise: -30 }))).toBe(0)
  })

  it('does not fire on the wrong diagonal (down-right / up-left)', () => {
    expect(run(wipePath({ rise: 80 }))).toBe(0)
    expect(classifyStroke({ x: 0, y: 0, t: 0 }, { x: 200, y: 40, t: 1 })).toBe('bad')
    expect(classifyStroke({ x: 200, y: 40, t: 0 }, { x: 0, y: 0, t: 1 })).toBe('bad')
    expect(classifyStroke({ x: 0, y: 40, t: 0 }, { x: 200, y: 0, t: 1 })).toBe('counts')
  })

  it('skips a stroke too short to count, but a long wrong one breaks the run', () => {
    expect(classifyStroke({ x: 0, y: 0, t: 0 }, { x: WIPE_MIN_STROKE_PX - 1, y: 0, t: 1 })).toBe('short')
    const first = wipePath({ strokes: 3, perStroke: 120 })
    const end = first[first.length - 1]
    const rest = (gap: WipePoint[]): WipePoint[] => {
      const from = gap[gap.length - 1]
      // Continue leftward (the 4th stroke) from the end of the gap.
      return wipePath({ strokes: 3, perStroke: 120, x0: from.x, y0: from.y, t0: from.t + 10 }).slice(1)
        .map((point) => ({ ...point, x: 2 * from.x - point.x, y: 2 * from.y - point.y }))
    }
    // A 30 px wiggle back left and on right again: noise.
    const wiggle: WipePoint[] = [
      { x: end.x - 30, y: end.y + 5, t: end.t + 20 },
      { x: end.x + 10, y: end.y - 5, t: end.t + 40 }
    ]
    expect(run([...first, ...wiggle, ...rest(wiggle)])).toBe(1)
    // A long leftward stroke heading up (the wrong diagonal), then right again.
    const wrong: WipePoint[] = [
      { x: end.x - 150, y: end.y - 60, t: end.t + 60 },
      { x: end.x, y: end.y - 120, t: end.t + 120 }
    ]
    expect(run([...first, ...wrong, ...rest(wrong)])).toBe(0)
  })

  it('does not fire when the wipes are too slow', () => {
    const perStroke = WIPE_WINDOW_MS / 4
    expect(perStroke).toBeLessThan(WIPE_MAX_PAUSE_MS)
    expect(run(wipePath({ perStroke }))).toBe(0)
  })

  it('starts over after a pause, but not after a shorter gap (the pointer out of the window)', () => {
    const first = wipePath({ strokes: 3, perStroke: 100 })
    const last = first[first.length - 1]
    const after = (gap: number): WipePoint[] =>
      wipePath({ strokes: 3, perStroke: 100, x0: last.x, y0: last.y, t0: last.t + gap })
        .map((point) => ({ ...point, x: 2 * last.x - point.x, y: 2 * last.y - point.y }))
    expect(after(WIPE_MAX_PAUSE_MS + 50).at(-1)!.t - first[0].t).toBeLessThan(WIPE_WINDOW_MS)
    expect(run([...first, ...after(WIPE_MAX_PAUSE_MS + 50)])).toBe(0)
    expect(run([...first, ...after(WIPE_MAX_PAUSE_MS - 150)])).toBe(1)
  })
})

describe('useWipeGesture', () => {
  function setup(isBlocked = (): boolean => false, input: WipeRect | null = INPUT): {
    onWipe: ReturnType<typeof vi.fn>
    move: (points: WipePoint[], buttons?: number) => void
  } {
    const onWipe = vi.fn()
    renderHook(() => useWipeGesture({ enabled: true, getInput: () => input, isBlocked, onWipe }))
    const move = (points: WipePoint[], buttons = 0): void => {
      for (const point of points) {
        const event = new MouseEvent('pointermove', { clientX: point.x, clientY: point.y, buttons, bubbles: true })
        Object.defineProperty(event, 'timeStamp', { value: point.t })
        Object.defineProperty(event, 'pointerType', { value: 'mouse' })
        document.body.dispatchEvent(event)
      }
    }
    return { onWipe, move }
  }

  it('fires on a recorded wipe, its moves outside the input included', () => {
    const { onWipe, move } = setup(undefined, cardOf(TAKES[2]))
    move(takeMoves(TAKES[2]))
    expect(onWipe).toHaveBeenCalledTimes(1)
  })

  it('does not fire on wipes over the transcript', () => {
    const { onWipe, move } = setup()
    move(wipePath({ y0: 315 }))
    expect(onWipe).not.toHaveBeenCalled()
  })

  it('resets on any keypress', () => {
    const { onWipe, move } = setup()
    const path = wipePath()
    move(path.slice(0, 60))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    move(path.slice(60))
    expect(onWipe).not.toHaveBeenCalled()
  })

  it('resets while blocked (a popup open, voice recording)', () => {
    let blocked = false
    const { onWipe, move } = setup(() => blocked)
    const path = wipePath()
    move(path.slice(0, 60))
    blocked = true
    move(path.slice(60, 61))
    blocked = false
    move(path.slice(61))
    expect(onWipe).not.toHaveBeenCalled()
  })

  it('does not count a drag (a button held)', () => {
    const { onWipe, move } = setup()
    move(wipePath(), 1)
    expect(onWipe).not.toHaveBeenCalled()
  })
})
