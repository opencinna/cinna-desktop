import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type TransitionEvent } from 'react'
import { useTranscriptDisclosure } from './transcriptExpansion'
import { ANCHOR_HOLD_MS, collapseMinOffset, holdAnchor } from './transcriptAnchor'
import { leaveBottom } from '../../hooks/useStickToBottom'

/**
 * The height a long user bubble is clamped to. Pixels, not lines: paste cards
 * and markdown blocks make a line count lie.
 */
export const BUBBLE_CLAMP_PX = 300
/** A clamp that would hide less than this is not worth a Show more. */
export const BUBBLE_CLAMP_SLACK_PX = 80
/** The expand / collapse transition. */
export const BUBBLE_CLAMP_TRANSITION_MS = 300

export interface BubbleClamp {
  /** The clipping box: max-height and overflow live here. */
  boxRef: React.RefObject<HTMLDivElement | null>
  /** The content inside the box, measured at its natural height. */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Whether the content is tall enough to clamp; the toggle exists only then. */
  overflowing: boolean
  expanded: boolean
  /** The box's style: the cap, the measured height while opening, or nothing. */
  boxStyle: CSSProperties | undefined
  toggle: () => void
  onTransitionEnd: (event: TransitionEvent<HTMLDivElement>) => void
}

/** The nearest scrolling ancestor — the transcript, wherever the bubble sits. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

/**
 * Clamp a long user bubble to {@link BUBBLE_CLAMP_PX} with Show more / Show
 * less. Render-only, so it applies to old messages too.
 *
 * - Measured in a layout effect and on every resize, so an old long message
 *   paints clamped on its first frame and re-decides when the width changes.
 * - Expanding animates `max-height` from the cap to the measured height, then
 *   drops the limit so later reflow is not capped. The bubble grows downward
 *   from where it was: the click counts as leaving the bottom (`leaveBottom`),
 *   so a pinned transcript does not follow the growth and scroll the lines the
 *   user opened off the top, and the bubble's top is held through the
 *   transition (`transcriptAnchor`).
 * - Collapsing from the toggle holds the bubble in place through the
 *   transition (`transcriptAnchor`), or brings its top back below the top
 *   padding when it was above the view, so the toggle stays on screen.
 * - The expanded state is a transcript disclosure: "Collapse expanded" closes
 *   it, and it lives as long as the bubble does (a new chat, a new state).
 */
export function useBubbleClamp(): BubbleClamp {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [expanded, setExpanded] = useTranscriptDisclosure(false)
  // True once the expand transition has ended and the limit is dropped.
  const [opened, setOpened] = useState(false)
  const openedRef = useRef(false)
  openedRef.current = opened
  const heightRef = useRef<number | null>(null)
  heightRef.current = height

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const measure = (): void => setHeight(content.offsetHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  const overflowing = height !== null && height - BUBBLE_CLAMP_PX >= BUBBLE_CLAMP_SLACK_PX

  // Collapsing from the dropped limit: `none` → px does not transition, so the
  // box is put at its measured height first and the cap is applied from there.
  useLayoutEffect(() => {
    if (expanded || !openedRef.current) return
    const box = boxRef.current
    const full = heightRef.current
    if (box && full !== null) {
      box.style.maxHeight = `${full}px`
      void box.offsetHeight
      box.style.maxHeight = `${BUBBLE_CLAMP_PX}px`
    }
    setOpened(false)
  }, [expanded])

  // The transition's end drops the limit; the timer covers a transition that
  // never fires one (reduced motion, a box that did not change height).
  useEffect(() => {
    if (!expanded || opened) return
    const timer = setTimeout(() => setOpened(true), BUBBLE_CLAMP_TRANSITION_MS + 50)
    return () => clearTimeout(timer)
  }, [expanded, opened])

  const onTransitionEnd = useCallback((event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'max-height') return
    if (expanded) setOpened(true)
  }, [expanded])

  const toggle = useCallback(() => {
    const box = boxRef.current
    const container = box ? scrollParent(box) : null
    if (!expanded) {
      if (box && container) {
        leaveBottom(container)
        holdAnchor(container, box)
      }
      setExpanded(true)
      return
    }
    if (box && container) holdAnchor(container, box, ANCHOR_HOLD_MS, collapseMinOffset(container))
    setExpanded(false)
  }, [expanded, setExpanded])

  let boxStyle: CSSProperties | undefined
  if (overflowing) {
    const transition = `max-height ${BUBBLE_CLAMP_TRANSITION_MS}ms ease-out`
    boxStyle = expanded && opened
      ? { transition }
      : { maxHeight: expanded ? height ?? undefined : BUBBLE_CLAMP_PX, overflow: 'hidden', transition }
  }

  return { boxRef, contentRef, overflowing, expanded, boxStyle, toggle, onTransitionEnd }
}
