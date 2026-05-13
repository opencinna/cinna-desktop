import { useEffect, useRef, useState } from 'react'

export type PopoverPlacement = 'above-left' | 'above-right' | 'below-right'

type FixedPos =
  | { left: number; bottom: number; right?: undefined; top?: undefined }
  | { right: number; bottom: number; left?: undefined; top?: undefined }
  | { right: number; top: number; left?: undefined; bottom?: undefined }

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

/**
 * Shared popover wiring used by sidebar-footer menus (UserMenu, InterfaceMenu).
 *
 * - Tracks open state.
 * - Measures the trigger via `getBoundingClientRect` to compute a `position: fixed`
 *   style for the popover, re-measuring on window resize.
 * - Wires an outside-click handler that ignores clicks on both the trigger and
 *   the popover (so a portaled popover still counts as "inside").
 *
 * Caller renders the popover via `createPortal` and spreads `style` onto it.
 */
export function usePopover<
  T extends HTMLElement = HTMLButtonElement,
  P extends HTMLElement = HTMLDivElement
>(placement: PopoverPlacement): PopoverApi<T, P> {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<T>(null)
  const popoverRef = useRef<P>(null)
  const [pos, setPos] = useState<FixedPos | null>(null)

  useEffect(() => {
    if (!open) {
      setPos(null)
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

  return {
    open,
    setOpen,
    triggerRef,
    popoverRef,
    style: pos ? { position: 'fixed', ...pos } : null
  }
}
