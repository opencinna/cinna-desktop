/**
 * Drives the fading caret (`caret-soft-fade`, main.css). Each keystroke or click
 * rewinds the focused field's fade to its opaque start, so it only begins to
 * pulse once the user pauses. After a long idle it parks there, solid: the fade
 * repaints every frame, and a composer can hold focus through a long read.
 */
export const CARET_IDLE_PARK_MS = 30_000

let parkTimer: ReturnType<typeof setTimeout> | undefined

function focusedFieldFades(): Animation[] {
  return (document.activeElement?.getAnimations() ?? []).filter(
    (animation) => animation instanceof CSSAnimation && animation.animationName === 'caret-soft-fade'
  )
}

function parkCaretFade(): void {
  for (const fade of focusedFieldFades()) {
    fade.pause()
    fade.currentTime = 0
  }
}

function wakeCaretFade(): void {
  for (const fade of focusedFieldFades()) {
    fade.currentTime = 0
    if (fade.playState === 'paused') fade.play()
  }
  clearTimeout(parkTimer)
  parkTimer = setTimeout(parkCaretFade, CARET_IDLE_PARK_MS)
}

export function initCaretFade(): void {
  // focusin: a field focused from code, or on return to the window, starts a
  // fresh fade with no input event to arm the timer that parks it.
  for (const type of ['keydown', 'input', 'pointerdown', 'focusin']) {
    document.addEventListener(type, wakeCaretFade, { capture: true, passive: true })
  }
}
