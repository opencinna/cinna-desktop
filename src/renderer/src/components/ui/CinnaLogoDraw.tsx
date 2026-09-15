import { useEffect, useId, useState, type CSSProperties } from 'react'
import { useUIStore } from '../../stores/ui.store'

// The app icon's wordmark (resources/cinna-desktop-icon-*.png) traced as closed
// outlines, with the ribbons' over/under crossings cut into the shapes and the
// corners softened. Every outline starts at its top-most point, so they all
// draw in the same way.
const OUTLINES = [
  'M37.7 71.8L35.1 72.0L30.3 73.0L25.9 74.5L21.6 76.6L17.6 79.3L15.5 80.9L12.1 84.4L9.2 88.2L6.9 92.2L5.8 94.6L4.2 99.2L3.3 104.0L3.0 108.6L3.3 113.6L3.7 116.0L4.9 120.5L6.9 125.2L8.0 127.3L10.6 131.1L13.9 134.9L15.7 136.6L19.4 139.4L23.7 141.9L28.2 143.8L30.5 144.5L35.1 145.4L40.1 145.7L44.7 145.4L47.1 145.0L51.8 143.8L56.5 141.8L58.6 140.7L62.4 138.1L66.2 134.8L69.2 131.5L69.7 130.4L69.7 128.8L69.0 127.5L58.8 119.5L57.4 118.9L56.3 119.0L55.5 119.3L51.2 123.4L48.2 125.3L45.9 126.2L42.5 127.0L40.0 127.2L37.5 127.0L34.1 126.2L30.7 124.7L28.7 123.4L26.9 121.8L25.3 120.0L24.0 118.0L22.5 114.6L21.7 111.1L21.5 107.6L21.9 105.0L22.9 101.6L24.6 98.5L26.1 96.4L28.7 94.0L31.8 92.1L35.1 90.9L37.7 90.4L41.2 90.2L44.8 90.8L47.1 91.6L50.2 93.3L52.3 94.8L55.2 97.9L55.9 98.3L57.0 98.5L58.2 98.3L58.8 97.9L69.2 89.6L69.8 88.2L69.7 87.0L69.4 86.3L67.8 84.2L64.5 80.9L62.4 79.3L58.4 76.6L54.2 74.6L51.8 73.6L47.3 72.4L42.5 71.8Z',
  'M85.0 73.0L83.9 73.2L82.9 73.9L82.2 74.9L82.0 76.0L82.0 141.9L82.2 142.6L82.9 143.6L83.9 144.3L84.6 144.5L96.9 144.5L98.0 144.1L98.9 143.3L99.3 142.6L99.5 141.5L99.5 75.6L99.1 74.5L98.6 73.9L98.0 73.4L96.9 73.0Z',
  'M165.9 69.7L164.8 69.9L163.8 70.6L163.2 71.6L163.0 72.7L163.0 109.6L162.5 110.7L161.2 111.1L160.3 110.5L131.9 76.2L131.2 74.5L130.4 73.6L129.7 73.2L128.6 73.0L116.0 73.0L114.9 73.2L113.9 73.9L113.2 74.9L113.0 76.0L113.0 141.5L113.2 142.6L114.2 143.9L115.2 144.4L116.0 144.5L130.8 144.5L132.3 144.2L133.2 144.5L177.8 189.1L189.2 201.1L192.5 203.9L196.2 206.6L200.4 208.8L204.5 210.5L207.6 211.5L212.4 212.5L221.5 213.4L229.7 213.3L233.3 212.8L237.6 211.9L244.1 209.7L248.1 207.8L251.3 205.9L255.0 203.4L257.8 201.1L263.2 195.5L266.3 191.3L269.5 185.8L271.8 180.1L273.3 175.0L274.2 169.1L274.5 164.0L274.5 151.6L274.1 150.5L273.3 149.6L272.6 149.2L271.5 149.0L254.5 149.0L253.4 149.2L252.4 149.9L251.7 150.9L251.5 152.0L251.4 166.6L250.8 170.0L249.8 173.3L248.0 177.2L245.5 180.8L242.5 183.9L239.0 186.5L235.9 188.1L232.7 189.3L230.1 190.0L226.7 190.4L222.5 190.5L216.5 189.9L213.4 189.2L210.1 188.0L207.4 186.4L203.9 183.3L194.2 172.9L132.0 110.7L131.6 110.1L131.5 96.8L132.0 95.8L133.1 95.4L134.1 95.9L176.4 138.1L177.4 138.8L178.1 139.0L179.3 138.9L180.0 138.6L181.1 137.5L181.5 136.0L181.5 87.4L181.4 86.6L180.8 85.4L168.0 70.5L167.0 69.9Z',
  'M125.6 2.5L122.0 2.8L115.6 3.8L108.3 6.2L102.4 9.0L96.7 12.8L91.9 17.1L86.9 23.0L83.4 28.5L80.6 34.7L78.8 40.9L77.8 47.0L77.5 51.8L77.5 64.0L77.7 65.1L78.1 65.8L79.0 66.6L80.1 67.0L97.5 67.0L98.6 66.8L99.6 66.1L100.3 65.1L100.5 64.0L100.5 52.1L100.7 48.6L101.4 45.2L102.5 41.9L104.5 38.0L107.1 34.5L110.8 31.0L114.5 28.6L117.6 27.2L120.2 26.4L123.5 25.7L126.9 25.5L134.3 26.1L138.3 27.0L142.0 28.3L145.4 29.9L150.1 32.9L153.1 35.5L157.6 39.8L162.1 44.9L194.8 83.5L195.0 84.2L195.0 141.5L195.2 142.6L195.9 143.6L196.9 144.3L198.0 144.5L210.5 144.5L212.0 144.1L213.1 143.0L213.5 141.5L213.5 109.4L214.0 108.4L215.0 108.0L216.2 108.5L244.1 141.4L244.7 142.9L245.5 143.8L246.6 144.4L247.4 144.5L259.9 144.5L261.3 143.9L262.3 142.6L262.5 141.5L262.5 76.0L262.4 75.2L261.9 74.2L260.6 73.2L259.5 73.0L247.1 73.0L246.0 73.4L245.1 74.2L244.6 75.2L244.5 76.0L244.5 102.4L244.3 103.1L243.7 103.6L243.0 103.8L242.2 103.6L179.6 30.0L174.4 24.1L168.6 18.4L163.7 14.5L156.8 9.9L151.1 7.1L144.4 4.8L137.7 3.3L130.4 2.6Z',
  'M299.7 73.0L298.6 73.2L297.3 74.2L270.4 140.4L270.2 141.5L270.4 142.7L271.0 143.6L272.4 144.4L285.0 144.4L286.1 143.9L286.9 143.0L294.2 125.0L295.0 124.2L295.7 124.0L321.4 124.0L322.2 124.3L322.7 124.9L330.0 142.6L330.9 143.9L331.6 144.3L332.8 144.5L344.8 144.5L346.3 144.1L347.2 143.3L347.8 141.9L347.6 140.3L320.1 74.8L319.1 73.6L318.4 73.2L317.3 73.0Z',
  'M307.8 92.6L309.0 92.6L309.9 93.4L317.4 111.9L317.5 113.0L316.9 113.7L316.1 114.0L300.3 113.8L299.7 113.3L299.4 112.6L299.6 111.9L307.1 93.4Z',
  'M224.0 2.5L216.8 3.2L212.5 4.1L209.1 5.1L202.4 8.0L196.2 11.7L193.4 13.9L188.9 18.2L188.2 19.2L188.0 19.9L188.1 20.8L188.5 21.9L199.9 35.3L200.5 35.9L201.6 36.3L202.7 36.3L203.8 35.9L208.2 31.5L211.4 29.2L214.9 27.5L218.6 26.3L224.1 25.5L228.1 25.7L233.6 27.0L237.3 28.5L242.0 31.7L244.8 34.4L248.1 39.0L249.7 42.6L251.2 48.2L251.5 52.2L251.5 64.0L251.7 65.1L252.4 66.1L253.4 66.8L254.5 67.0L271.5 67.0L273.0 66.6L274.1 65.5L274.5 64.0L274.5 52.0L274.0 45.3L272.5 38.2L270.0 31.4L268.0 27.6L266.2 24.5L261.7 18.8L256.5 13.8L253.6 11.6L248.3 8.3L244.9 6.7L240.9 5.1L233.9 3.3L230.3 2.8Z',
  'M97.5 149.0L79.7 149.1L78.7 149.6L78.1 150.2L77.6 151.2L77.5 164.0L77.7 168.1L78.6 174.2L79.5 177.8L80.9 181.9L84.0 188.5L87.4 193.7L89.8 196.6L92.8 199.7L95.5 202.2L98.4 204.4L103.7 207.7L107.1 209.3L111.1 210.9L118.1 212.7L121.7 213.2L128.0 213.5L131.7 213.3L135.9 212.7L143.0 210.8L148.8 208.4L152.0 206.7L155.7 204.3L158.5 202.2L161.3 199.7L164.6 196.1L165.0 194.6L165.0 193.8L164.4 192.7L152.1 180.3L150.4 179.5L149.3 179.5L148.3 180.0L145.1 183.3L140.6 186.7L137.1 188.5L133.4 189.7L127.9 190.5L123.9 190.3L118.4 189.0L114.7 187.5L110.0 184.3L107.2 181.6L103.9 177.0L102.3 173.4L100.8 167.8L100.5 163.8L100.5 152.0L100.3 150.9L99.6 149.9L98.6 149.2Z'
]

// The draw transition's duration on .cinna-logo-draw-lines paths in main.css.
const DRAW_MS = 5000
const random = (min: number, max: number): number => min + Math.random() * (max - min)

/** `angle` is the direction the band sweeps in, in degrees. */
type Sweep = { angle: number; duration: number }

/**
 * The wordmark as a wireframe, hidden until its space is clicked. A click draws
 * every outline in together; the next draws them back out. Decorative.
 */
export function CinnaLogoDraw({ className = '' }: { className?: string }): React.JSX.Element {
  const animate = useUIStore((s) => s.extraUIAnimation)
  const gradientId = useId()
  const [shown, setShown] = useState(false)
  const [sweep, setSweep] = useState<Sweep | null>(null)

  // Once the logo is drawn, a band sweeps through it now and then at a random
  // angle, paced like the secondary buttons' border glow (useAmbientButtons).
  useEffect(() => {
    if (!animate || !shown || !window.matchMedia) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer: ReturnType<typeof setTimeout>
    const drawnAt = Date.now() + DRAW_MS
    const play = (): void => {
      if (document.hidden || motion.matches) return
      const duration = random(4200, 5600)
      setSweep({ angle: random(0, 360), duration })
      timer = setTimeout(() => {
        setSweep(null)
        timer = setTimeout(play, random(8000, 18000))
      }, duration)
    }
    const restart = (delay: number): void => {
      clearTimeout(timer)
      setSweep(null)
      if (!document.hidden && !motion.matches) timer = setTimeout(play, delay)
    }
    // A visibility or motion change part-way through the draw still waits for it to finish.
    const resume = (): void => restart(Math.max(random(4000, 9000), drawnAt - Date.now() + random(1000, 4000)))
    restart(DRAW_MS + random(1000, 4000))
    document.addEventListener('visibilitychange', resume)
    motion.addEventListener('change', resume)
    return () => {
      clearTimeout(timer)
      // Hiding the logo takes a sweep in progress with it.
      setSweep(null)
      document.removeEventListener('visibilitychange', resume)
      motion.removeEventListener('change', resume)
    }
  }, [animate, shown])

  // ChatTransition's outgoing snapshot strips ids, which breaks the gradient
  // reference; the colour behind it keeps the logo painted while it fades.
  const strokePaint = { stroke: `url(#${gradientId}) var(--color-logo-from)` }

  return (
    <svg
      viewBox="0 0 352 216"
      width={101}
      height={62}
      aria-hidden="true"
      focusable="false"
      className={`cinna-logo-draw ${className}`}
      data-animate={animate || undefined}
      data-shown={shown || undefined}
      onClick={() => setShown((s) => !s)}
    >
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="352" y2="216">
          <stop offset="0" style={{ stopColor: 'var(--color-logo-from)' }} />
          <stop offset="1" style={{ stopColor: 'var(--color-logo-to)' }} />
        </linearGradient>
      </defs>
      <g className="cinna-logo-draw-lines" fill="none" style={strokePaint} strokeWidth="4.2" strokeLinejoin="round" strokeLinecap="round">
        {OUTLINES.map((d) => <path key={d} d={d} pathLength={1} />)}
      </g>
      {animate && shown && sweep && (
        <>
          <defs>
            {/* A luminance mask: the band is opaque in the middle and clear at its edges. */}
            <linearGradient id={`${gradientId}-band`}>
              <stop offset="0" stopColor="white" stopOpacity={0} />
              <stop offset="0.5" stopColor="white" stopOpacity={0.5} />
              <stop offset="1" stopColor="white" stopOpacity={0} />
            </linearGradient>
            <mask id={`${gradientId}-sweep`} maskUnits="userSpaceOnUse" x="-20" y="-20" width="392" height="256">
              <g transform={`translate(176 108) rotate(${sweep.angle})`}>
                <rect
                  className="cinna-logo-sweep"
                  x={-55}
                  y={-300}
                  width={110}
                  height={600}
                  fill={`url(#${gradientId}-band)`}
                  style={{ '--sweep-duration': `${sweep.duration}ms` } as CSSProperties}
                />
              </g>
            </mask>
          </defs>
          {/* The same outlines again, less transparent, seen only where the band passes. */}
          <g mask={`url(#${gradientId}-sweep)`} fill="none" style={strokePaint} strokeWidth="4.2" strokeLinejoin="round" strokeLinecap="round">
            {OUTLINES.map((d) => <path key={d} d={d} />)}
          </g>
        </>
      )}
    </svg>
  )
}
