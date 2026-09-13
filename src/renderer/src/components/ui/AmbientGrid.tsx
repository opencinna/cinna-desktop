import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useUIStore } from '../../stores/ui.store'

const CELL = 24
const OFFSET = 12
const FADE_MS = 350
const random = (min: number, max: number): number => min + Math.random() * (max - min)

type Point = { x: number; y: number }
type Trail = { edges: string[]; delay: number }
type Burst = { origin: Point; trails: Trail[]; duration: number }
type BorderBurst = { duration: number; angle: number }

// A directed trunk with two short forks feels like a discharge spreading along
// the grid. Shared visited nodes prevent branches from reconnecting into boxes.
function makeTrails(origin: Point, columns: number, rows: number): Trail[] {
  const directions = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]
  const key = ({ x, y }: Point): string => `${x},${y}`
  const visited = new Set([key(origin)])
  const distance = ({ x, y }: Point): number => Math.abs(x - origin.x) + Math.abs(y - origin.y)
  const walk = (start: Point, heading: Point, steps: number): Point[] => {
    const points = [start]
    let previousDirection = heading
    for (let i = 0; i < steps; i++) {
      const point = points[points.length - 1]
      const choices = directions.map((direction) => {
        const next = { x: point.x + direction.x, y: point.y + direction.y }
        const forward = direction.x * heading.x + direction.y * heading.y
        const continuing = direction.x === previousDirection.x && direction.y === previousDirection.y
        const nearTrail = directions.some(({ x, y }) => {
          const neighbor = { x: next.x + x, y: next.y + y }
          return key(neighbor) !== key(point) && visited.has(key(neighbor))
        })
        return {
          next,
          direction,
          weight: (forward > 0 ? 4 : forward === 0 ? 2 : 0.5)
            * (continuing ? 1.5 : 1)
            * (distance(next) > distance(point) ? 1.3 : 0.7)
            * (nearTrail ? 0.2 : 1)
        }
      }).filter(({ next: { x, y } }) =>
        x >= 0 && x <= columns && y >= 0 && y <= rows && !visited.has(key({ x, y }))
      )
      if (!choices.length) break
      let roll = random(0, choices.reduce((sum, choice) => sum + choice.weight, 0))
      const choice = choices.find(({ weight }) => (roll -= weight) < 0) ?? choices[choices.length - 1]
      points.push(choice.next)
      visited.add(key(choice.next))
      previousDirection = choice.direction
    }
    return points
  }

  const trail = (points: Point[], delay: number): Trail => ({
    delay,
    edges: points.slice(1).map((point, i) => {
      const previous = points[i]
      return `M${OFFSET + previous.x * CELL},${OFFSET + previous.y * CELL}L${OFFSET + point.x * CELL},${OFFSET + point.y * CELL}`
    })
  })
  // Favor the long axis, especially in a shallow composer, and head into space.
  const horizontal = random(0, columns + rows) < columns
  const heading = horizontal
    ? { x: origin.x < columns / 2 ? 1 : -1, y: 0 }
    : { x: 0, y: origin.y < rows / 2 ? 1 : -1 }
  const trunk = walk(origin, heading, Math.floor(random(12, 18)))
  const trails = [trail(trunk, 0)]
  if (trunk.length < 4) return trails
  for (let fork = 0; fork < 2; fork++) {
    const index = Math.floor((trunk.length - 1) * random(fork ? 0.5 : 0.2, fork ? 0.65 : 0.4))
    const point = trunk[index]
    const next = trunk[index + 1]
    const side = fork ? -1 : 1
    const branch = walk(point, { x: -(next.y - point.y) * side, y: (next.x - point.x) * side }, Math.floor(random(4, 8)))
    // A fork lights only after the pulse reaches its attachment on the trunk.
    trails.push(trail(branch, index * 220 + 140))
  }
  return trails
}

/** Decorative, intermittent motion. The host needs the ambient-grid-surface class. */
export function AmbientGrid({ active = true, inputRef, borderColor, borderGlow = !!inputRef }: {
  active?: boolean
  inputRef?: RefObject<HTMLTextAreaElement | null>
  borderGlow?: boolean
  /** Current surface border tint, including chat-mode and drag-over states. */
  borderColor?: string
}): React.JSX.Element {
  const extraUIAnimation = useUIStore((s) => s.extraUIAnimation)
  const enabled = active && extraUIAnimation
  const ref = useRef<HTMLDivElement>(null)
  const patternId = useId()
  const [burst, setBurst] = useState<Burst | null>(null)
  const [borderBurst, setBorderBurst] = useState<BorderBurst | null>(null)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    if (!enabled || !window.matchMedia) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const input = inputRef?.current
    let timer: ReturnType<typeof setTimeout>
    let fadeTimer: ReturnType<typeof setTimeout>
    let borderTimer: ReturnType<typeof setTimeout>
    let disposed = false
    let interacting = false

    const play = (): void => {
      if (disposed || interacting || document.hidden || motion.matches) return
      const bounds = ref.current?.getBoundingClientRect()
      if (!bounds || bounds.width < CELL || bounds.height < CELL) {
        timer = setTimeout(play, random(12000, 24000))
        return
      }
      const columns = Math.floor((bounds.width - OFFSET * 2) / CELL)
      const rows = Math.floor((bounds.height - OFFSET * 2) / CELL)
      const origin = {
        x: Math.floor(random(0, columns + 1)),
        y: Math.floor(random(0, rows + 1))
      }
      const duration = random(6500, 8500)
      setFading(false)
      setBurst({
        origin: { x: OFFSET + origin.x * CELL, y: OFFSET + origin.y * CELL },
        trails: makeTrails(origin, columns, rows),
        duration
      })
      timer = setTimeout(() => {
        setBurst(null)
        timer = setTimeout(play, random(12000, 24000))
      }, duration)
    }

    const playBorder = (): void => {
      if (disposed || interacting || document.hidden || motion.matches || !borderGlow) return
      const bounds = ref.current?.getBoundingClientRect()
      if (!bounds?.width || !bounds.height) {
        borderTimer = setTimeout(playBorder, random(35000, 70000))
        return
      }
      const duration = random(4200, 6000)
      setFading(false)
      setBorderBurst({ duration, angle: Math.floor(random(0, 4)) * 90 })
      borderTimer = setTimeout(() => {
        setBorderBurst(null)
        borderTimer = setTimeout(playBorder, random(35000, 70000))
      }, duration)
    }

    const restart = (): void => {
      clearTimeout(timer)
      clearTimeout(fadeTimer)
      clearTimeout(borderTimer)
      setBurst(null)
      setBorderBurst(null)
      setFading(false)
      if (!interacting && !document.hidden && !motion.matches) {
        timer = setTimeout(play, random(1500, 4500))
        if (borderGlow) borderTimer = setTimeout(playBorder, random(18000, 35000))
      }
    }
    const quiet = (): void => {
      if (interacting) return
      interacting = true
      clearTimeout(timer)
      clearTimeout(fadeTimer)
      clearTimeout(borderTimer)
      setFading(true)
      // Keep the current artwork mounted until its outer layer has faded.
      fadeTimer = setTimeout(() => {
        setBurst(null)
        setBorderBurst(null)
      }, FADE_MS)
    }
    const resume = (): void => {
      if (!interacting) return
      interacting = false
      clearTimeout(timer)
      if (!document.hidden && !motion.matches) {
        timer = setTimeout(play, random(12000, 24000))
        if (borderGlow) borderTimer = setTimeout(playBorder, random(35000, 70000))
      }
    }
    // Autofocus alone leaves the idle effect available. Actual interaction
    // silences it until the user leaves the field, then a full quiet interval.
    const interactionEvents = ['pointerdown', 'keydown', 'beforeinput', 'input', 'compositionstart'] as const
    interactionEvents.forEach((event) => input?.addEventListener(event, quiet))
    input?.addEventListener('blur', resume)
    restart()
    document.addEventListener('visibilitychange', restart)
    motion.addEventListener('change', restart)
    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(fadeTimer)
      clearTimeout(borderTimer)
      interactionEvents.forEach((event) => input?.removeEventListener(event, quiet))
      input?.removeEventListener('blur', resume)
      document.removeEventListener('visibilitychange', restart)
      motion.removeEventListener('change', restart)
    }
  }, [enabled, inputRef, borderGlow])

  return (
    <div ref={ref} className="ambient-grid" data-fading={fading || undefined} aria-hidden="true"
      style={{ '--ambient-input-tint': borderColor } as CSSProperties}>
      {enabled && borderGlow && borderBurst && (
        <span className="ambient-surface-border" style={{
          '--button-glow-duration': `${borderBurst.duration}ms`,
          '--button-start-angle': `${borderBurst.angle}deg`
        } as CSSProperties} />
      )}
      {enabled && burst && (
        <svg
          className="ambient-grid-burst"
          width="100%"
          height="100%"
          focusable="false"
          style={{
            '--grid-duration': `${burst.duration}ms`,
            '--grid-origin-x': `${burst.origin.x}px`,
            '--grid-origin-y': `${burst.origin.y}px`
          } as CSSProperties}
        >
          <defs>
            <pattern id={patternId} x={OFFSET} y={OFFSET} width={CELL} height={CELL} patternUnits="userSpaceOnUse">
              <path d={`M${CELL} 0H0V${CELL}`} fill="none" stroke="currentColor" strokeWidth="0.6" />
            </pattern>
          </defs>
          <rect className="ambient-grid-lines" width="100%" height="100%" fill={`url(#${patternId})`} />
          {burst.trails.flatMap((trail, trailIndex) => trail.edges.map((edge, edgeIndex) => (
            <g key={`${trailIndex}-${edgeIndex}`} style={{
              '--edge-delay': `${700 + trail.delay + edgeIndex * 220}ms`
            } as CSSProperties}>
              <path className="ambient-grid-edge ambient-grid-edge-halo" d={edge} />
              <path className="ambient-grid-edge" d={edge} />
            </g>
          )))}
        </svg>
      )}
    </div>
  )
}
