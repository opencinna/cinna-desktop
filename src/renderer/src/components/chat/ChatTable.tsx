import { useEffect, useLayoutEffect, useRef, type ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import { useUIStore } from '../../stores/ui.store'

/** Rounding slack: a table that fits can still report a scrollWidth a pixel over. */
const FIT_SLACK_PX = 1
/** How far a header must have left its place in the table to count as stuck. */
const STUCK_SLACK_PX = 0.5

/**
 * True when the table's content is wider than its box — only unbreakable
 * content gets there; a table whose cells can wrap squashes to the bubble.
 */
export function tableOverflows(table: HTMLElement): boolean {
  return table.scrollWidth > table.clientWidth + FIT_SLACK_PX
}

/**
 * Where a sticky header goes, from viewport positions: `headTop` is where
 * sticky alone puts it, `tableTop` the table's top, `lastRowTop` the last body
 * row's top (null: no body). Stuck once it has left the table's top. `shift`
 * (≤ 0) pushes it up with the last row, so it leaves as that row arrives
 * rather than at the table's bottom edge: a header over no rows says nothing.
 */
export function headerPlacement(
  headTop: number,
  headHeight: number,
  tableTop: number,
  lastRowTop: number | null
): { stuck: boolean; shift: number } {
  const stuck = headTop - tableTop > STUCK_SLACK_PX
  const shift = stuck && lastRowTop !== null ? Math.min(0, lastRowTop - (headTop + headHeight)) : 0
  return { stuck, shift }
}

/**
 * A markdown table in a chat message. With sticky headers on, its header
 * cells stick to the transcript (main.css); a table is not a scroll container
 * there. A table that does not fit the bubble needs its own sideways scroll,
 * and a scroll container keeps sticky cells inside it, so such a table is
 * marked `data-table-scrolls` and keeps the plain behaviour.
 *
 * Measured after every render (a streamed table grows a chunk at a time, and
 * may only widen its content while its box stays capped at the bubble) and on
 * every resize of its box (the window). The attribute is set on the element
 * directly, so nothing re-renders. It changes only `overflow`: a table that
 * fits measures the same either way, and one that overflows gains (or loses)
 * its horizontal scrollbar, as it always had one under `overflow: auto`.
 *
 * While it is on screen it follows the transcript's scroll for what CSS
 * cannot say: whether the header is stuck (`data-head-stuck`, which draws its
 * shadow, glow and the band above it), and `--head-shift`, which slides it up
 * with the last row (`headerPlacement`).
 */
export function ChatTable({ node: _node, ...props }: ComponentProps<'table'> & ExtraProps): React.JSX.Element {
  const ref = useRef<HTMLTableElement>(null)
  const sticky = useUIStore((s) => s.stickyTableHeaders)
  const placeRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    const table = ref.current
    if (!table) return
    table.toggleAttribute('data-table-scrolls', tableOverflows(table))
    placeRef.current()
  })

  useLayoutEffect(() => {
    const table = ref.current
    if (!table || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      table.toggleAttribute('data-table-scrolls', tableOverflows(table))
      placeRef.current()
    })
    observer.observe(table)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const table = ref.current
    const scroller = table?.closest<HTMLElement>('[data-sticky-tables]')
    let shift = 0
    const reset = (): void => {
      if (!table) return
      table.removeAttribute('data-head-stuck')
      table.style.removeProperty('--head-shift')
      shift = 0
    }
    if (!table || !scroller || !sticky) {
      reset()
      placeRef.current = () => {}
      return
    }
    let onScreen = typeof IntersectionObserver === 'undefined'
    const place = (): void => {
      const head = table.tHead?.rows[0]?.cells[0]
      if (!onScreen || !head || table.hasAttribute('data-table-scrolls')) return reset()
      const body = table.tBodies[0]
      const lastRow = body && body.rows.length > 0 ? body.rows[body.rows.length - 1] : null
      const headRect = head.getBoundingClientRect()
      // The rect includes the current shift; take it back out for where sticky put it.
      const next = headerPlacement(
        headRect.top - shift,
        headRect.height,
        table.getBoundingClientRect().top,
        lastRow ? lastRow.getBoundingClientRect().top : null
      )
      table.toggleAttribute('data-head-stuck', next.stuck)
      if (next.shift !== shift) {
        shift = next.shift
        if (shift === 0) table.style.removeProperty('--head-shift')
        else table.style.setProperty('--head-shift', `${shift}px`)
      }
    }
    placeRef.current = place
    const visibility = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting)
          place()
        }, { root: scroller })
    visibility?.observe(table)
    scroller.addEventListener('scroll', place, { passive: true })
    place()
    return () => {
      scroller.removeEventListener('scroll', place)
      visibility?.disconnect()
      placeRef.current = () => {}
      reset()
    }
  }, [sticky])

  return <table ref={ref} {...props} />
}
