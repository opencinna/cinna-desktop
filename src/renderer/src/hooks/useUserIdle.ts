import { useEffect, useState } from 'react'

/**
 * Ambient ("Extra UI animation") motion comes in two classes:
 *
 * - Heavy — large-area or attention-grabbing motion. Plays only while the user
 *   is idle app-wide (see below), and any activity fades it out. Currently:
 *   the AmbientGrid lightning burst (composer, sidebar, Local Development).
 * - Subtle — small, brief and local. May keep playing during active use on its
 *   own cadence. Currently: the AmbientGrid border glow, the secondary buttons'
 *   and cards' border glow (useAmbientButtons), the header buttons' wave
 *   (TopBar), the logo sweep (CinnaLogoDraw), the chat tooltip's one-pass
 *   glow (ChatItemTooltip) and the text caret's fade (caretFade).
 *
 * Responses to the user's own action (ChatTransition, RouterBadge's width
 * transition) and functional signals (the composer notice's orbit) are neither.
 * A new ambient animation picks a class; a heavy one subscribes here.
 *
 * Idle means: no pointer, key, wheel, scroll or input activity anywhere in the
 * window for the threshold, with the window focused and visible. Blur or a
 * hidden document is never idle; coming back starts the clock again. Focus
 * inside an iframe (an HTML dashboard tile) counts as away too: its pointer
 * and key events never reach this window, so the user typing there would
 * otherwise read as idle.
 */
export const HEAVY_AMBIENT_IDLE_MS = 45_000

/** pointermove arrives at frame rate; between two handled moves this much passes. */
const MOVE_THROTTLE_MS = 250

const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'input'] as const

type Subscriber = {
  thresholdMs: number
  listener: (idle: boolean) => void
  idle: boolean
  timer?: ReturnType<typeof setTimeout>
}

const subscribers = new Set<Subscriber>()
let lastActivity = 0
let foreground = false

// By tag, not instanceof: the element may come from another realm.
const focusInFrame = (): boolean => document.activeElement?.tagName === 'IFRAME'

const isForeground = (): boolean =>
  document.hasFocus() && document.visibilityState !== 'hidden' && !focusInFrame()

function setIdle(subscriber: Subscriber, idle: boolean): void {
  if (subscriber.idle === idle) return
  subscriber.idle = idle
  subscriber.listener(idle)
}

// The timer is set once per quiet stretch, not per event: when it fires it
// checks the clock and waits out the rest if activity happened meanwhile.
function arm(subscriber: Subscriber): void {
  clearTimeout(subscriber.timer)
  if (!foreground) return
  const check = (): void => {
    // Focus may have gone into an iframe without an event this window saw.
    if (!isForeground()) {
      onForeground()
      return
    }
    const remaining = lastActivity + subscriber.thresholdMs - Date.now()
    if (remaining > 0) subscriber.timer = setTimeout(check, remaining)
    else setIdle(subscriber, true)
  }
  subscriber.timer = setTimeout(check, Math.max(0, lastActivity + subscriber.thresholdMs - Date.now()))
}

function onActivity(event: Event): void {
  const now = Date.now()
  if (event.type === 'pointermove' && now - lastActivity < MOVE_THROTTLE_MS) return
  lastActivity = now
  subscribers.forEach((subscriber) => {
    if (!subscriber.idle) return
    setIdle(subscriber, false)
    arm(subscriber)
  })
}

function onForeground(): void {
  const next = isForeground()
  if (next === foreground) return
  foreground = next
  // Coming back counts as activity; leaving is never idle.
  lastActivity = Date.now()
  subscribers.forEach((subscriber) => {
    setIdle(subscriber, false)
    arm(subscriber)
  })
}

function install(): void {
  lastActivity = Date.now()
  foreground = isForeground()
  ACTIVITY_EVENTS.forEach((type) => window.addEventListener(type, onActivity, { capture: true, passive: true }))
  window.addEventListener('focus', onForeground)
  window.addEventListener('blur', onForeground)
  // Focus moving between this document and an iframe in it.
  document.addEventListener('focusin', onForeground)
  document.addEventListener('visibilitychange', onForeground)
}

function uninstall(): void {
  ACTIVITY_EVENTS.forEach((type) => window.removeEventListener(type, onActivity, { capture: true }))
  window.removeEventListener('focus', onForeground)
  window.removeEventListener('blur', onForeground)
  document.removeEventListener('focusin', onForeground)
  document.removeEventListener('visibilitychange', onForeground)
}

/**
 * Calls `listener` whenever the user's app-wide idle state flips for the given
 * threshold. One shared set of passive window listeners serves every
 * subscriber. Starts not idle; returns the unsubscribe.
 */
export function subscribeUserIdle(thresholdMs: number, listener: (idle: boolean) => void): () => void {
  if (subscribers.size === 0) install()
  const subscriber: Subscriber = { thresholdMs, listener, idle: false }
  subscribers.add(subscriber)
  arm(subscriber)
  return () => {
    clearTimeout(subscriber.timer)
    subscribers.delete(subscriber)
    if (subscribers.size === 0) uninstall()
  }
}

/** Whether the user has been idle app-wide for `thresholdMs`; see subscribeUserIdle. */
export function useUserIdle(thresholdMs = HEAVY_AMBIENT_IDLE_MS): boolean {
  const [idle, setIdleState] = useState(false)
  useEffect(() => {
    setIdleState(false)
    return subscribeUserIdle(thresholdMs, setIdleState)
  }, [thresholdMs])
  return idle
}
