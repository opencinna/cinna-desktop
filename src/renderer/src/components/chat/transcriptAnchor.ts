/**
 * Keeping the reader's place while blocks above and around it collapse.
 *
 * "Collapse expanded" closes every block the user opened, and a group closes
 * over a 300 ms height transition. Without help the browser keeps `scrollTop`
 * and the content moves under it — measured at 3845 → 317 in a transcript
 * whose open 90-step group the reader was halfway through (ux_rules §1).
 *
 * So the transcript picks what the reader is looking at before collapsing and
 * holds it at the same distance from the viewport top, re-applied every frame
 * for the length of the transition. The group keeps its animation; the view
 * does not move. Frame by frame rather than once because the height changes
 * across the transition, and `requestAnimationFrame` runs after the commit and
 * before paint, so no frame is drawn with the view in the wrong place.
 */

/** `useStickToBottom`'s band. At the bottom the stick model owns the view. */
const BOTTOM_BAND_PX = 64

/** The group transition, plus a frame or two. */
export const ANCHOR_HOLD_MS = 350

/**
 * The first top-level transcript node that reaches below the top padding. When
 * that node is a group about to collapse, its header instead: the group's steps
 * are what disappears, and the header is where the reader lands.
 *
 * Measured from the padding rather than the container's edge, because that is
 * where a group header lands. A group that ends under the top bar is not what
 * the reader is on: picking it would bring its header down to the padding and
 * push the node the reader was on down by the header's height.
 */
export function collapseAnchor(container: HTMLElement, content: HTMLElement): HTMLElement | null {
  const viewTop = container.getBoundingClientRect().top + collapseMinOffset(container)
  for (const node of Array.from(content.children) as HTMLElement[]) {
    if (node.getBoundingClientRect().bottom <= viewTop) continue
    return node.querySelector<HTMLElement>(':scope > [data-group-header][aria-expanded="true"]') ?? node
  }
  return null
}

/**
 * The offset a group header lands at: the scroll area's own top padding. Above
 * it the header sits inside the transcript's top fade and under the window's
 * drag strip, where it cannot be clicked. Read from computed style, so it
 * follows `--topbar-h` rather than restating it.
 */
export function collapseMinOffset(container: HTMLElement): number {
  return parseFloat(getComputedStyle(container).paddingTop) || 0
}

/**
 * Pick what the reader is looking at and hold it through the collapse. A group
 * header lands just below the top padding rather than staying above the view.
 * Returns the release function, or null when there is nothing to hold.
 */
export function holdCollapseAnchor(container: HTMLElement, content: HTMLElement): (() => void) | null {
  const anchor = collapseAnchor(container, content)
  if (!anchor) return null
  const minOffset = anchor.hasAttribute('data-group-header') ? collapseMinOffset(container) : undefined
  return holdAnchor(container, anchor, undefined, minOffset)
}

/**
 * Hold `anchor` at its current offset from `container`'s top for `ms` — or at
 * `minOffset`, when it starts above that. Stops early when the user wheels,
 * when the view reaches the bottom band, or when the anchor leaves the
 * document. Returns the release function.
 *
 * `minOffset` is for a group header: a reader halfway through an open group has
 * its header far above the viewport, and holding it there would put the view
 * past the collapsed group. Holding it at the top lands the reader on it.
 */
export function holdAnchor(container: HTMLElement, anchor: Element, ms = ANCHOR_HOLD_MS, minOffset = -Infinity): () => void {
  const offsetOf = (): number => anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
  const offset = Math.max(minOffset, offsetOf())
  const until = performance.now() + ms
  let frame = 0
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    cancelAnimationFrame(frame)
    container.removeEventListener('wheel', release)
  }
  const step = (): void => {
    if (released) return
    if (!anchor.isConnected) return release()
    const drift = offsetOf() - offset
    if (Math.abs(drift) >= 1) container.scrollTop += drift
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_BAND_PX
    if (atBottom || performance.now() >= until) return release()
    frame = requestAnimationFrame(step)
  }
  // The reader taking the view back ends the hold at once.
  container.addEventListener('wheel', release, { passive: true })
  frame = requestAnimationFrame(step)
  return release
}
