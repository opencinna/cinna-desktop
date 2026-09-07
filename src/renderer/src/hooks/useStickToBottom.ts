import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * How close to the bottom counts as "at the bottom". Wide enough that a
 * sub-pixel `scrollHeight` rounding or the last line of a growing paragraph
 * does not silently unpin the view, narrow enough that a deliberate scroll of
 * one wheel notch does.
 */
const BOTTOM_THRESHOLD_PX = 64

/**
 * How long an upward wheel gesture suspends sticking.
 *
 * Not one frame. Within a rendering opportunity the order is scroll steps →
 * `requestAnimationFrame` callbacks → **resize-observer steps** → paint, so a
 * suspension released from a rAF is already gone by the time the observer that
 * it was meant to hold off runs. Worse, a wheel scroll handled off the main
 * thread need not have reached `scrollTop` by that rAF at all, so releasing
 * there can read the pre-gesture position, conclude nothing moved, and stick —
 * which is the "cannot scroll up" bug, one frame later.
 *
 * A window measured in milliseconds outlives both. Nothing is lost by holding
 * it: if the gesture really did scroll the container, the `scroll` event
 * unpins on its own and the suspension is moot; if it did not — the wheel
 * belonged to a nested scroller — the transcript resumes following when the
 * window closes, a delay no one can see mid-stream.
 */
const WHEEL_SUSPEND_MS = 150

/**
 * How far the view must move up before that counts as the user leaving the
 * bottom. Bigger than a device-pixel rounding, because the one window where
 * `movedUp` decides anything is the frame in which a tall chunk has already
 * opened up distance and the stick has not run yet — and there a 2px trackpad
 * tremor, or a scroll-anchoring adjustment landing in the same frame as the
 * chunk, is otherwise enough to unpin a transcript nobody was leaving.
 */
const MOVED_UP_SLACK_PX = 4

export interface StickToBottom {
  /** The scrolling element. */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** The element whose height changes — observed to keep the view at the bottom. */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Whether the view is currently following the bottom of the content. */
  pinned: boolean
  /** Re-pin and jump to the bottom (used by the "jump to latest" affordance). */
  scrollToBottom: () => void
}

/**
 * Follow the bottom of a growing scroll container **only while the user wants
 * it followed**.
 *
 * Two things this deliberately does *not* do, both of which it replaces:
 *
 *  - **It never animates.** The previous implementation called
 *    `scrollIntoView({ behavior: 'smooth' })` from an effect keyed on the
 *    streaming state, so every chunk that arrived started a fresh several-
 *    hundred-millisecond animation over the one still running. At the chunk
 *    rate of a local engine printing a table that reads as the window
 *    shaking. Sticking is a `scrollTop` assignment inside a `ResizeObserver`
 *    callback — that fires after layout and before paint, so the bottom of the
 *    content is simply where it always was; there is no intermediate frame to
 *    see.
 *  - **It never scrolls when unpinned.** The old effect had no notion of where
 *    the user was: reading back through a long answer meant being dragged to
 *    the bottom on the next chunk. Scrolling up unpins, scrolling back to
 *    within {@link BOTTOM_THRESHOLD_PX} of the bottom re-pins, and both work
 *    mid-stream.
 *
 * `resetKey` (the chat id) re-pins and jumps: opening a different chat starts
 * at its latest message, whatever the previous chat's scroll state was.
 */
export function useStickToBottom(resetKey?: string | null): StickToBottom {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [pinned, setPinnedState] = useState(true)
  // Mirrored in a ref because the ResizeObserver and scroll callbacks are
  // registered once and would otherwise close over a stale `pinned`.
  const pinnedRef = useRef(true)

  const setPinned = useCallback((next: boolean) => {
    pinnedRef.current = next
    setPinnedState((prev) => (prev === next ? prev : next))
  }, [])

  // The last scroll position this hook itself wrote. Kept so that a `scroll`
  // event can tell "the user moved the view" from "we put it there".
  const lastTopRef = useRef(0)
  // Held for {@link WHEEL_SUSPEND_MS} after an upward wheel gesture (see below).
  const wheelSuspendRef = useRef(false)
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Where the container was when the current suspension opened. What
  // distinguishes a gesture that is scrolling *this* element from one a nested
  // scroller is swallowing.
  const suspendTopRef = useRef(0)

  const stick = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastTopRef.current = el.scrollTop
  }, [])

  /**
   * Cancel any open wheel suspension. Anything that deliberately puts the view
   * at the bottom must call this: the suspension exists to protect a gesture
   * in flight, and these are the events that supersede one.
   */
  const releaseSuspension = useCallback(() => {
    if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current)
    wheelTimerRef.current = null
    wheelSuspendRef.current = false
  }, [])

  const scrollToBottom = useCallback(() => {
    releaseSuspension()
    setPinned(true)
    stick()
  }, [releaseSuspension, setPinned, stick])

  /**
   * Decide, from the DOM rather than from anything remembered, whether the
   * view is following the bottom. The only thing that sets the pinned state.
   *
   * **Unpinning requires the view to have actually moved up.** Distance from
   * the bottom is not sufficient on its own, because `stick()` runs in a
   * ResizeObserver callback and the `scroll` event that assignment queues is
   * not dispatched until the next frame's scroll steps — by which time React
   * may have committed another chunk. This handler reads live geometry, so it
   * would measure that growth as distance the user never opened up and unpin a
   * transcript that is faithfully following. A chunk tall enough to clear the
   * threshold in one frame (a table gaining rows, a code block appearing, the
   * hand-off from streaming blocks to the persisted message) would stop the
   * stream following, mid-stream, for no reason the user could see.
   *
   * Scrolling up is the one thing that *decreases* `scrollTop`; content
   * growing never does. So that, and not distance alone, is what unpins.
   */
  const settle = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const top = el.scrollTop
    const movedUp = top < lastTopRef.current - MOVED_UP_SLACK_PX
    lastTopRef.current = top
    const distance = el.scrollHeight - top - el.clientHeight
    if (distance <= BOTTOM_THRESHOLD_PX) {
      setPinned(true)
      return
    }
    if (movedUp) setPinned(false)
  }, [setPinned])

  // Keep the view at the bottom whenever the content grows and we are pinned.
  // A ResizeObserver rather than a render-keyed effect: it also catches the
  // reflows React does not re-render for — a code block laying out, an image
  // finishing, a collapsible opening, a partial markdown table becoming a real
  // one on the next chunk.
  //
  // Both boxes are observed, and both in their default content-box, because
  // the distance to the bottom moves for two independent reasons: the
  // transcript grows, and the *viewport* changes under it — the window is
  // resized, or the composer gains a line and the scroller's bottom padding
  // grows with it. The latter never resizes the content element, so watching
  // that alone left the newest line drifting under the composer.
  useEffect(() => {
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) {
        if (!wheelSuspendRef.current) stick()
        return
      }
      // Unpinned, and the content just changed size. Shrinking it can put the
      // view back inside the band without moving `scrollTop` at all — no clamp,
      // so no scroll event, so nothing would otherwise recompute and the pill
      // would linger a few pixels from the bottom. Safe to call here under the
      // `movedUp` rule: a resize never decreases `scrollTop`, so this can only
      // ever re-pin, never unpin.
      //
      // Safe from re-entry only while nothing `settle()` can toggle sits inside
      // an observed box. Today the "jump to latest" pill is a *sibling* of the
      // scroll container, so mounting and unmounting it resizes neither — an
      // invariant that lives in MessageStream, not here. Move the pill inside
      // and this becomes resize → settle → setPinned → render → resize.
      settle()
    })
    ro.observe(content)
    ro.observe(container)
    return () => ro.disconnect()
  }, [settle, stick])

  // The user's own scrolling is what decides pinned-ness. Any scroll that ends
  // away from the bottom unpins; any that ends at it re-pins, which is how the
  // user opts back into following mid-stream.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // An upward wheel or trackpad gesture suspends sticking for
    // {@link WHEEL_SUSPEND_MS} — a chunk landing while the gesture is in
    // flight must not pull the view back out from under it, and the gesture
    // may not have reached `scrollTop` yet.
    //
    // The suspension is its own ref, never the pinned state. Setting the state
    // here would flash the "jump to latest" pill for any wheel too small to
    // leave the threshold; overwriting `pinnedRef` would destroy the very
    // value that has to be restored when the gesture turns out not to have
    // scrolled this container at all — the common case, since `wheel` bubbles
    // and the transcript is full of nested scrollers (a tool result's
    // `max-h-96 overflow-y-auto`, a patch block, a command result).
    const arm = (): void => {
      wheelSuspendRef.current = true
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current)
      wheelTimerRef.current = setTimeout(() => {
        wheelTimerRef.current = null
        wheelSuspendRef.current = false
        // Settle first, then catch up: whatever arrived during the suspension
        // was not stuck to, so a still-pinned transcript is behind the bottom.
        settle()
        if (pinnedRef.current) stick()
      }, WHEEL_SUSPEND_MS)
    }
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY >= 0) return
      if (!wheelSuspendRef.current) {
        suspendTopRef.current = el.scrollTop
        arm()
        return
      }
      // A suspension is already open. Extend it only if this container is the
      // thing actually moving.
      //
      // Refreshing on every wheel unconditionally would let a swallowed
      // gesture hold the suspension open for as long as the user keeps
      // scrolling — ten seconds of reading inside a tool result freezes the
      // transcript for ten seconds and then takes the whole catch-up in one
      // assignment, which is a jump, not the invisible resume the window is
      // supposed to be. Declining to extend turns that into a series of 150ms
      // pauses the user cannot see, each catching up a chunk or two, while a
      // gesture that *is* scrolling the transcript still holds the suspension
      // for its whole duration.
      //
      // This read inherits the main-thread lag WHEEL_SUSPEND_MS is written
      // against, so one event of a fast compositor-handled gesture can compare
      // equal and decline to extend. It is allowed to be wrong: later events in
      // the same gesture see the committed offset and re-arm, and a gesture
      // that has left the band was unpinned by its own scroll events, so the
      // trailing catch-up is skipped. What is left is a gesture still inside
      // the band, where being stuck back to the bottom is what the band means.
      if (el.scrollTop !== suspendTopRef.current) {
        suspendTopRef.current = el.scrollTop
        arm()
      }
    }
    el.addEventListener('scroll', settle, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', settle)
      el.removeEventListener('wheel', onWheel)
      // The flag as well as the timer. Dropping the timer alone would leave a
      // suspension that nothing is left to lift, and sticking would never
      // resume.
      releaseSuspension()
    }
  }, [releaseSuspension, settle, stick])

  // A different chat is a different transcript: start at its bottom. Any
  // suspension belongs to the transcript being left, and holding it would open
  // the new one at the top and then jump it to the bottom when the timer fired.
  useLayoutEffect(() => {
    releaseSuspension()
    setPinned(true)
    stick()
  }, [releaseSuspension, resetKey, setPinned, stick])

  return { containerRef, contentRef, pinned, scrollToBottom }
}
