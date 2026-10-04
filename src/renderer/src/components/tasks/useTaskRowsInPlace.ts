import { useCallback, useMemo, useRef, useState } from 'react'

/**
 * A polled task list that does not move under the pointer — the two rules the
 * Tasks view's lists and a task page's Subtasks share.
 *
 * ## The order each row was first seen in, held for the life of the mount
 *
 * The queries behind both lists are `ORDER BY updated_at DESC` re-run every
 * five seconds, so without this **any** task changing — an agent writing
 * progress, a peer's row arriving over sync — jumps to the top and pushes every
 * row below it down by one, under whatever the pointer was on (`ux_rules.md`
 * §1). The cost is that a task updated while the list is open keeps its place,
 * and a new one appends at the end. Both resolve on the next mount, which is
 * when the order is taken again — so a caller that shows a different list in
 * the same place must remount (a `key`).
 *
 * ## Show more leaves nothing clickable under the pointer that pressed it
 *
 * Show more reveals every remaining row at once, and they go **below** the
 * button's slot, not above it: the caller renders the first page (`head`), then
 * the slot, then the rest (`rest`). Once pressed, the slot holds an inert line
 * of the button's height ("All N shown"), so the pointer that pressed it rests
 * on text, and nothing above it moved — no scroll compensation needed.
 */
export function useTaskRowsInPlace<T extends { id: string }>(
  rows: T[],
  pageSize: number,
  /**
   * Where a row first seen after mount goes. `'append'` (the Tasks view) keeps
   * every row above it still; `'prepend'` (a job's Tasks history, newest
   * first) puts a run the user just started where they look for it, above
   * any "Show more". Rows already seen keep their order either way.
   */
  newRows: 'append' | 'prepend' = 'append'
): {
  ordered: T[]
  /** The rows above the Show more slot: the first page. */
  head: T[]
  /** The rows below the slot: empty until Show more, then every other row. */
  rest: T[]
  /** The slot holds the Show more button. */
  more: boolean
  /** Show more has been pressed — the slot holds the inert "All N shown" line. */
  expanded: boolean
  showMore: () => void
} {
  const order = useRef<string[]>([])
  const ordered = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]))
    const known = new Set(order.current)
    const fresh = rows.filter((row) => !known.has(row.id))
    if (fresh.length > 0) {
      const freshIds = fresh.map((row) => row.id)
      order.current = newRows === 'prepend' ? [...freshIds, ...order.current] : [...order.current, ...freshIds]
    }
    return order.current.map((id) => byId.get(id)).filter((row) => row !== undefined)
  }, [rows, newRows])

  const [expanded, setExpanded] = useState(false)
  const showMore = useCallback(() => setExpanded(true), [])

  return {
    ordered,
    head: ordered.slice(0, pageSize),
    rest: expanded ? ordered.slice(pageSize) : [],
    more: !expanded && ordered.length > pageSize,
    expanded,
    showMore
  }
}
