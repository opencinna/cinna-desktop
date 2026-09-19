import { useEffect } from 'react'
import { useUIStore } from '../stores/ui.store'

const random = (min: number, max: number): number => min + Math.random() * (max - min)

/**
 * One visible, explicitly opted-in secondary button glows at a time. A card
 * marked `data-ambient-card` (the job and task pages' Details) takes its turn
 * among them, so a card and a button never glow together.
 */
export function useAmbientButtons(): void {
  const enabled = useUIStore((s) => s.extraUIAnimation)
  useEffect(() => {
    if (!enabled || !window.matchMedia) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer: ReturnType<typeof setTimeout>
    let current: HTMLElement | undefined

    const clear = (): void => {
      clearTimeout(timer)
      current?.removeAttribute('data-ambient-glow')
      current?.style.removeProperty('--button-start-angle')
      current?.style.removeProperty('--button-glow-duration')
      current = undefined
    }
    const play = (): void => {
      if (document.hidden || motion.matches) return
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('button.ambient-button:not(:disabled), .ambient-button[data-ambient-card]'))
        .filter((button) => {
          if (!button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
          const bounds = button.getBoundingClientRect()
          const x = bounds.x + bounds.width / 2
          const y = bounds.y + bounds.height / 2
          if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) return false
          // Excludes buttons behind dialogs, clipped by scrollers, or hidden panels.
          return button.contains(document.elementFromPoint(x, y))
        })
      current = candidates[Math.floor(Math.random() * candidates.length)]
      if (!current) {
        timer = setTimeout(play, random(8000, 16000))
        return
      }
      const duration = random(4200, 5600)
      current.style.setProperty('--button-start-angle', `${Math.floor(random(0, 4)) * 90}deg`)
      current.style.setProperty('--button-glow-duration', `${duration}ms`)
      current.setAttribute('data-ambient-glow', '')
      timer = setTimeout(() => {
        clear()
        timer = setTimeout(play, random(8000, 18000))
      }, duration)
    }
    const restart = (): void => {
      clear()
      if (!document.hidden && !motion.matches) timer = setTimeout(play, random(4000, 9000))
    }
    restart()
    document.addEventListener('visibilitychange', restart)
    motion.addEventListener('change', restart)
    return () => {
      clear()
      document.removeEventListener('visibilitychange', restart)
      motion.removeEventListener('change', restart)
    }
  }, [enabled])
}
