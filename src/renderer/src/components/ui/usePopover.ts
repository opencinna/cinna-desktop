import { useLayoutEffect, useRef, useState } from 'react'

export type PopoverPlacement = 'above-left' | 'above-right' | 'below-right' | 'right'

export type FixedPos =
  | { left: number; bottom: number; right?: undefined; top?: undefined }
  | { right: number; bottom: number; left?: undefined; top?: undefined }
  | { right: number; top: number; left?: undefined; bottom?: undefined }
  | { left: number; top: number; right?: undefined; bottom?: undefined }

export interface PopoverOptions {
  /**
   * Once an `above-*` popover has been laid out, pin its top edge where it
   * opened, so content that grows while it is open extends it downward
   * instead of pushing the rows under the pointer up. It may then cover its
   * trigger. Re-anchored above the trigger on the next open or a resize.
   */
  keepTopWhileOpen?: boolean
}

/**
 * An `above-*` position (bottom-anchored) turned into the same box anchored by
 * its top edge, at `top`. Any other position is returned as is.
 */
export function pinTopEdge(pos: FixedPos, top: number): FixedPos {
  if (pos.bottom === undefined) return pos
  return pos.left !== undefined ? { left: pos.left, top } : { right: pos.right!, top }
}

export interface PopoverApi<T extends HTMLElement, P extends HTMLElement> {
  open: boolean
  setOpen: (open: boolean) => void
  triggerRef: React.RefObject<T | null>
  popoverRef: React.RefObject<P | null>
  /** `null` until the trigger has been measured. Spread onto a `position: fixed`
   *  element to anchor it to the trigger. */
  style: React.CSSProperties | null
}

const GAP = 8 // px between trigger edge and popover (used for above-*)
const BELOW_GAP = 4
/** `right` only: close enough for the pointer to cross onto a hoverable popover; it may overlap the sidebar card's edge. */
const RIGHT_GAP = 4
/** Smallest gap kept between a popover and the window edge. */
const EDGE = 8

/**
 * Shared popover wiring used by sidebar-footer menus (UserMenu, InterfaceMenu).
 *
 * - Tracks open state.
 * - Measures the trigger via `getBoundingClientRect` to compute a `position: fixed`
 *   style for the popover, re-measuring on window resize.
 * - Wires an outside-click handler that ignores clicks on both the trigger and
 *   the popover (so a portaled popover still counts as "inside").
 * - Shifts the popover back inside the window when the anchor would push it
 *   past an edge. Every placement anchors one horizontal side to the trigger,
 *   which is fine for a trigger in a corner — where this hook started — and not
 *   fine for one in the middle of a dialog, where a wide popover can hang off
 *   the far side of a narrow window.
 *
 * Caller renders the popover via `createPortal` and spreads `style` onto it.
 */
export function usePopover<
  T extends HTMLElement = HTMLButtonElement,
  P extends HTMLElement = HTMLDivElement
>(placement: PopoverPlacement, options: PopoverOptions = {}): PopoverApi<T, P> {
  const keepTop = options.keepTopWhileOpen === true
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<T>(null)
  const popoverRef = useRef<P>(null)
  const [pos, setPos] = useState<FixedPos | null>(null)
  /** Horizontal correction, applied as a transform so the anchors stay as-is. */
  const [shift, setShift] = useState(0)
  /** Vertical correction — `right` only, the one placement that hangs down beside its trigger. */
  const [shiftY, setShiftY] = useState(0)

  // A layout effect: measured in the frame it opens, so a popover that follows
  // the pointer from row to row never paints one frame of nothing in between.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      setShift(0)
      setShiftY(0)
      return
    }
    const measure = (): void => {
      const t = triggerRef.current
      if (!t) return
      const r = t.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      switch (placement) {
        case 'above-left':
          setPos({ left: r.left, bottom: vh - r.top + GAP })
          break
        case 'above-right':
          setPos({ right: vw - r.right, bottom: vh - r.top + GAP })
          break
        case 'below-right':
          setPos({ right: vw - r.right, top: r.bottom + BELOW_GAP })
          break
        case 'right':
          // Beside the trigger, top edges level: a row's tooltip, which must
          // cover neither the row nor the rows the pointer moves on to.
          setPos({ left: r.right + RIGHT_GAP, top: r.top })
          break
      }
    }
    function handleClick(e: MouseEvent): void {
      const target = e.target as Node
      const insideTrigger = triggerRef.current?.contains(target)
      const insidePopover = popoverRef.current?.contains(target)
      if (!insideTrigger && !insidePopover) setOpen(false)
    }
    measure()
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('resize', measure)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('resize', measure)
    }
  }, [open, placement])

  // After the popover has been laid out, not before: the correction depends on
  // how wide it actually turned out to be. A layout effect, so the adjustment
  // lands in the same frame the popover first paints rather than as a visible
  // jump.
  //
  // The correction is computed **from the unshifted anchor** — the measured
  // rect minus the shift already applied — and is therefore absolute rather
  // than relative. That is what makes it idempotent: re-running on an unchanged
  // layout produces the same number and settles in one pass, and, less
  // obviously, it is the only version that can *release*. A relative
  // adjustment can only ever be added to, so a popover shifted left in a narrow
  // window would stay shifted when the window was dragged wider — both branches
  // simply stop firing, and nothing returns it to its anchor.
  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!open || !pos || !el) return
    const r = el.getBoundingClientRect()
    // Nothing measurable, nothing to correct. Guards two real cases: an element
    // that has not been laid out yet, and a test environment (jsdom) where
    // every rect is zero — where "it starts before the left edge" would
    // otherwise be true forever and the correction would never settle.
    if (r.width === 0) return
    const vw = window.innerWidth
    const left = r.left - shift
    const right = r.right - shift
    let next = 0
    if (right > vw - EDGE) next = vw - EDGE - right
    // Only when it actually fits: a popover wider than the window cannot
    // satisfy both edges, and trying would move it back and forth forever.
    if (left + next < EDGE && r.width <= vw - EDGE * 2) next = EDGE - left
    // Whole pixels. `getBoundingClientRect` is fractional, and a comparison
    // between two floats that differ by a rounding residue is a re-render loop
    // with no visible motion.
    next = Math.round(next)
    if (next !== shift) setShift(next)
  }, [open, pos, shift])

  // The same correction, vertically, for `right`: a trigger near the bottom of
  // the window would otherwise hang its popover past the edge. The other
  // placements grow away from an edge they were designed against and are left
  // exactly as they were. Absolute, whole pixels and guarded for the same
  // reasons as the horizontal one above.
  useLayoutEffect(() => {
    const el = popoverRef.current
    if (placement !== 'right' || !open || !pos || !el) return
    const r = el.getBoundingClientRect()
    if (r.height === 0) return
    const vh = window.innerHeight
    const top = r.top - shiftY
    const bottom = r.bottom - shiftY
    let next = 0
    if (bottom > vh - EDGE) next = vh - EDGE - bottom
    // The top edge wins when both cannot be kept: the first line says who.
    if (top + next < EDGE) next = EDGE - top
    next = Math.round(next)
    if (next !== shiftY) setShiftY(next)
  }, [placement, open, pos, shiftY])

  // Pinned in the same frame it is first laid out, so the switch never shows.
  useLayoutEffect(() => {
    const el = popoverRef.current
    if (!keepTop || !open || !pos || pos.bottom === undefined || !el) return
    const r = el.getBoundingClientRect()
    if (r.height === 0) return
    setPos(pinTopEdge(pos, Math.round(r.top)))
  }, [keepTop, open, pos])

  return {
    open,
    setOpen,
    triggerRef,
    popoverRef,
    style: pos
      ? {
          position: 'fixed',
          ...pos,
          ...(shiftY !== 0
            ? { transform: `translate(${shift}px, ${shiftY}px)` }
            : shift === 0 ? {} : { transform: `translateX(${shift}px)` })
        }
      : null
  }
}
