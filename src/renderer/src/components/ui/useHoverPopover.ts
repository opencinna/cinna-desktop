import { useCallback, useEffect, useId, useRef } from 'react'
import { usePopover, type PopoverApi, type PopoverPlacement } from './usePopover'

/** Long enough for the pointer to cross the gap from the trigger to the popover. */
export const HOVER_CLOSE_DELAY_MS = 200

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export interface HoverPopoverApi<T extends HTMLElement, P extends HTMLElement>
  extends PopoverApi<T, P> {
  /** Spread onto the trigger button. */
  triggerProps: {
    'aria-expanded': boolean
    'aria-controls': string | undefined
    'aria-haspopup': 'dialog'
    onMouseEnter: () => void
    onMouseLeave: () => void
    onFocus: () => void
    onBlur: () => void
    onClick: () => void
    onKeyDown: (event: React.KeyboardEvent) => void
  }
  /** Spread onto the portaled popover element. */
  popoverProps: {
    id: string
    role: 'dialog'
    onPointerMove: () => void
    onMouseLeave: () => void
    onFocus: () => void
    onBlur: () => void
    onKeyDown: (event: React.KeyboardEvent) => void
  }
  /** Close now, whatever opened it (a row inside was chosen). */
  close: () => void
}

interface Reasons {
  /** The pointer is on the trigger. */
  hover: boolean
  /** The pointer has moved inside the popover and not left it. */
  inside: boolean
  /** Focus is on the trigger or inside the popover. */
  focus: boolean
  pinned: boolean
  /** Escape or an unpinning click: stays shut until the pointer or focus returns. */
  dismissed: boolean
}

const IDLE: Reasons = { hover: false, inside: false, focus: false, pinned: false, dismissed: false }

/**
 * A `usePopover` that opens on hover and on keyboard focus, for a trigger whose
 * popover holds details and, possibly, buttons — so it is a non-modal dialog,
 * never `role="tooltip"`.
 *
 * - **Hover / focus** open it; leaving both closes it after
 *   `HOVER_CLOSE_DELAY_MS`, so the pointer can travel from the trigger into the
 *   popover without it vanishing on the way. Inside the popover only a real
 *   pointer *move* counts: a popover that appears under a still pointer (or is
 *   moved under it by a layout change) gets a `mouseenter` the user never made.
 * - **Click / Enter** pins it: it stays open without the pointer until a second
 *   click, Escape or a click outside (the outside click is `usePopover`'s).
 *   Pinning from the keyboard moves focus to the first focusable element
 *   inside, since a portaled popover is not in the tab order after its trigger.
 *   Tab past the last one (Shift+Tab before the first) closes it and hands
 *   focus back to the trigger.
 * - **Escape**, anywhere, while it is open, closes it and goes no further — an
 *   Escape typed in the composer then closes the popover rather than counting
 *   toward Esc Esc. Focus returns to the trigger only if it was inside.
 */
export function useHoverPopover<
  T extends HTMLElement = HTMLButtonElement,
  P extends HTMLElement = HTMLDivElement
>(placement: PopoverPlacement): HoverPopoverApi<T, P> {
  // Rows inside may grow (a refusal line under a Stop): they grow downward, so
  // nothing moves out from under the pointer (`ux_rules.md` §1).
  const popover = usePopover<T, P>(placement, { keepTopWhileOpen: true })
  const { open, setOpen, triggerRef, popoverRef } = popover
  const id = useId()
  const reasons = useRef<Reasons>({ ...IDLE })
  const timer = useRef<number | null>(null)
  const refocusing = useRef(false)

  const clearTimer = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }

  const sync = useCallback((): void => {
    const r = reasons.current
    const want = !r.dismissed && (r.pinned || r.hover || r.inside || r.focus)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    if (want) {
      setOpen(true)
    } else {
      timer.current = window.setTimeout(() => {
        timer.current = null
        setOpen(false)
      }, HOVER_CLOSE_DELAY_MS)
    }
  }, [setOpen])

  const close = useCallback((): void => {
    reasons.current = { ...IDLE, dismissed: true }
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    setOpen(false)
  }, [setOpen])

  /** Close and put focus back on the trigger without that focus reopening it. */
  const closeToTrigger = useCallback((): void => {
    close()
    const trigger = triggerRef.current
    if (!trigger || document.activeElement === trigger) return
    refocusing.current = true
    trigger.focus()
  }, [close, triggerRef])

  // However it closed — outside click, a badge that left the DOM with focus on
  // it (no blur fires for that) — forget every reason it was open, so the next
  // hover starts fresh rather than on a stale pin or focus. `dismissed` stays:
  // it is the one reason that is about staying shut.
  useEffect(() => {
    if (!open) reasons.current = { ...IDLE, dismissed: reasons.current.dismissed }
  }, [open])

  // Escape at document level, first: the composer's own Escape handling must
  // not see a key press whose meaning was "close this".
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      const inside = popoverRef.current?.contains(document.activeElement)
      if (inside) closeToTrigger()
      else close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, close, closeToTrigger, popoverRef])

  useEffect(() => clearTimer, [])

  /**
   * The pointer left: a focused element that has since left the DOM (the Stop
   * button of a row that just ended) fired no blur, so the focus reason is
   * checked against where focus really is before it keeps the popover open.
   */
  const leave = (patch: Partial<Reasons>): void => {
    const active = document.activeElement
    const held = !!active && active !== document.body &&
      (!!triggerRef.current?.contains(active) || !!popoverRef.current?.contains(active))
    set(held ? patch : { ...patch, focus: false })
  }

  const set = (patch: Partial<Reasons>): void => {
    reasons.current = { ...reasons.current, ...patch }
    sync()
  }

  return {
    ...popover,
    close,
    triggerProps: {
      'aria-expanded': open,
      'aria-controls': open ? id : undefined,
      'aria-haspopup': 'dialog',
      onMouseEnter: () => set({ hover: true, dismissed: false }),
      onMouseLeave: () => leave({ hover: false }),
      onFocus: () => {
        // Focus handed back on close is not a request to reopen it; focus
        // arriving any other way (Tab) is.
        if (refocusing.current) {
          refocusing.current = false
          return
        }
        set({ focus: true, dismissed: false })
      },
      onBlur: () => set({ focus: false }),
      onClick: () => {
        if (reasons.current.pinned) {
          close()
          return
        }
        set({ pinned: true, dismissed: false })
      },
      onKeyDown: (event) => {
        if (event.key === 'ArrowDown' || ((event.key === 'Enter' || event.key === ' ') && !reasons.current.pinned)) {
          event.preventDefault()
          set({ pinned: true, dismissed: false })
          // After the popover has rendered.
          window.setTimeout(() => {
            popoverRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
          }, 0)
        }
      }
    },
    popoverProps: {
      id,
      role: 'dialog',
      onPointerMove: () => {
        if (!reasons.current.inside) set({ inside: true })
      },
      onMouseLeave: () => leave({ inside: false }),
      onFocus: () => set({ focus: true }),
      onBlur: () => set({ focus: false }),
      onKeyDown: (event) => {
        if (event.key !== 'Tab') return
        const focusable = [...(popoverRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
        const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1]
        if (edge && document.activeElement === edge) {
          event.preventDefault()
          closeToTrigger()
        }
      }
    }
  }
}
