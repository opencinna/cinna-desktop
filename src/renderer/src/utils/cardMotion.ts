/**
 * The modal card's entrance and exit, shared by the file preview and the Run
 * Script window: the card grows from the click that opened it (the centre
 * after a keyboard open) and shrinks back to it, the backdrop fades with it,
 * and reduced motion only fades. The window can also shrink into another
 * element's rect (the Commands badge) on its way out.
 */

/** Short enough to never be waited on. */
export const CARD_MOTION: KeyframeAnimationOptions = { duration: 170, easing: 'cubic-bezier(0.2, 0, 0, 1)' }

export interface CardOrigin {
  x: number
  y: number
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

const SCALE_FROM = 0.92

/**
 * Play the entrance. The card's rect is read before any transform applies,
 * so call it once the card is laid out at its final size. Answers the
 * animations started (none where the platform cannot animate).
 */
export function playCardEntrance(card: HTMLElement, backdrop: HTMLElement | null, origin: CardOrigin | null): Animation[] {
  if (typeof card.animate !== 'function') return []
  const rect = card.getBoundingClientRect()
  card.style.transformOrigin = origin ? `${origin.x - rect.left}px ${origin.y - rect.top}px` : 'center'
  const animations = [
    card.animate(
      prefersReducedMotion()
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: `scale(${SCALE_FROM})` },
            { opacity: 1, transform: 'scale(1)' }
          ],
      CARD_MOTION
    )
  ]
  const fade = backdrop?.animate?.([{ opacity: 0 }, { opacity: 1 }], CARD_MOTION)
  if (fade) animations.push(fade)
  return animations
}

/**
 * Play the exit, holding its last frame: the entrance backwards, from the
 * origin the entrance set, or — with `into` — a shrink and move into that
 * rect (the badge the window collapses into). Reduced motion only fades.
 */
export function playCardExit(card: HTMLElement, backdrop: HTMLElement | null, into: DOMRect | null = null): Animation[] {
  if (typeof card.animate !== 'function') return []
  const exit: KeyframeAnimationOptions = { ...CARD_MOTION, fill: 'forwards' }
  let frames: Keyframe[]
  if (prefersReducedMotion()) {
    frames = [{ opacity: 1 }, { opacity: 0 }]
  } else if (into) {
    const rect = card.getBoundingClientRect()
    const scale = Math.max(0.02, Math.min(into.width / Math.max(1, rect.width), into.height / Math.max(1, rect.height)))
    const dx = into.left + into.width / 2 - (rect.left + rect.width / 2)
    const dy = into.top + into.height / 2 - (rect.top + rect.height / 2)
    card.style.transformOrigin = 'center'
    frames = [
      { opacity: 1, transform: 'translate(0, 0) scale(1)' },
      { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(${scale})` }
    ]
  } else {
    frames = [
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: `scale(${SCALE_FROM})` }
    ]
  }
  const animations = [card.animate(frames, exit)]
  const fade = backdrop?.animate?.([{ opacity: 1 }, { opacity: 0 }], exit)
  if (fade) animations.push(fade)
  return animations
}
