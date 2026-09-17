import { useLayoutEffect, useMemo, useRef, useState } from 'react'

/**
 * A polled task list that does not move under the pointer — the two rules the
 * Inbox's Recent tasks and a task page's Subtasks share.
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
 * ## Show more keeps its button under the pointer that pressed it
 *
 * The revealed rows are inserted above the button, which would drop it by their
 * height and slide a task row into the pixels it left; a second click then opens
 * a task nobody chose. The nearest `scrollSelector` ancestor is scrolled by
 * exactly the height that was added. That is allowed where a poll-driven shift
 * is not: it is the direct consequence of the user's own gesture.
 *
 * On the last page the button goes away, and compensating for the rows alone
 * would then put a task row where it was. So once the list has been expanded,
 * the caller renders a line of the button's height in its place (`expanded`),
 * and the same compensation lands that line under the pointer.
 */
export function useTaskRowsInPlace<T extends { id: string }>(
  rows: T[],
  pageSize: number,
  scrollSelector: string
): {
  ordered: T[]
  visible: number
  /** Show more has been pressed — the button's slot must stay filled. */
  expanded: boolean
  showMore: () => void
  sectionRef: React.RefObject<HTMLElement | null>
} {
  const order = useRef<string[]>([])
  const ordered = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]))
    const known = new Set(order.current)
    const fresh = rows.filter((row) => !known.has(row.id))
    if (fresh.length > 0) order.current = [...order.current, ...fresh.map((row) => row.id)]
    return order.current.map((id) => byId.get(id)).filter((row) => row !== undefined)
  }, [rows])

  const [visible, setVisible] = useState(pageSize)
  const sectionRef = useRef<HTMLElement | null>(null)
  const grownFrom = useRef<number | null>(null)

  const showMore = (): void => {
    grownFrom.current = sectionRef.current?.getBoundingClientRect().height ?? null
    setVisible((count) => count + pageSize)
  }

  useLayoutEffect(() => {
    const before = grownFrom.current
    grownFrom.current = null
    if (before === null || !sectionRef.current) return
    const grew = sectionRef.current.getBoundingClientRect().height - before
    const scroller = sectionRef.current.closest(scrollSelector)
    if (scroller && grew > 0) scroller.scrollTop += grew
  }, [visible, scrollSelector])

  return { ordered, visible, expanded: visible > pageSize, showMore, sectionRef }
}
