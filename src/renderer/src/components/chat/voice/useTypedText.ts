import { useEffect, useRef, useState } from 'react'
import { keystrokesBetween, typeToward } from './dictationSpan'

/** A quick typist: characters typed per second, and backspaces (twice as fast). */
const TYPE_PER_SECOND = 45
const DELETE_PER_SECOND = 90
/** Past this much work left, speed up in proportion, so a burst is caught up in well under a second. */
const MAX_BACKLOG = 8
const TICK_MS = 16

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * `target` as typed out by a quick typist: letter by letter, and where the
 * recognizer revises earlier words, backspaced to where they agree and
 * retyped. Speeds up when it falls behind, so it trails the recognizer by
 * well under a second. Inactive, or with reduced motion, it is `target`
 * itself; each activation starts typing from nothing.
 */
export function useTypedText(target: string, active: boolean): string {
  const [shown, setShown] = useState('')
  const shownRef = useRef('')
  const targetRef = useRef(target)
  targetRef.current = target
  const instant = !active || reducedMotion()

  useEffect(() => {
    if (!active) {
      shownRef.current = ''
      setShown('')
    }
  }, [active])

  useEffect(() => {
    if (instant || shownRef.current === target) return
    let budget = 0
    let last = performance.now()
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      const now = performance.now()
      const elapsed = (now - last) / 1000
      last = now
      const goal = targetRef.current
      const current = shownRef.current
      const backlog = keystrokesBetween(current, goal)
      const deleting = current.length > 0 && !goal.startsWith(current)
      const base = deleting ? DELETE_PER_SECOND : TYPE_PER_SECOND
      budget += elapsed * base * Math.max(1, backlog / MAX_BACKLOG)
      const steps = Math.floor(budget)
      if (steps > 0) {
        budget -= steps
        const next = typeToward(current, goal, steps)
        shownRef.current = next
        setShown(next)
        if (next === goal) return
      }
      timer = setTimeout(tick, TICK_MS)
    }
    timer = setTimeout(tick, TICK_MS)
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [target, instant])

  return instant ? target : shown
}
