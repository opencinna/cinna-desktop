import { useEffect } from 'react'
import { Download } from 'lucide-react'
import { useUpdaterStore } from '../../stores/updater.store'

const ICON_SIZE = 14
// Inset the ring inside the button so it doesn't clip the icon.
const RING_SIZE = 22
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export function UpdateStatusButton(): React.JSX.Element | null {
  const state = useUpdaterStore((s) => s.state)
  const subscribe = useUpdaterStore((s) => s.subscribe)
  const promptInstall = useUpdaterStore((s) => s.promptInstall)

  useEffect(() => {
    void subscribe()
  }, [subscribe])

  if (state.phase === 'idle') return null

  if (state.phase === 'downloading') {
    const percent = Math.max(0, Math.min(100, state.percent))
    const dashOffset = RING_CIRCUMFERENCE * (1 - percent / 100)
    const versionTag = state.version ? ` ${state.version}` : ''
    return (
      <div
        title={`Downloading update${versionTag} — ${percent.toFixed(0)}%`}
        className="relative p-1.5 rounded-md text-[var(--color-text-muted)]"
      >
        <Download size={ICON_SIZE} />
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          className="absolute inset-0 m-auto pointer-events-none -rotate-90"
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth={RING_STROKE}
            opacity={0.4}
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="var(--color-accent, currentColor)"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 200ms linear' }}
          />
        </svg>
      </div>
    )
  }

  // phase === 'downloaded'
  return (
    <button
      onClick={() => {
        void promptInstall()
      }}
      title={`Update ${state.version} ready — click to restart and install`}
      className="relative p-1.5 rounded-md text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
    >
      <Download size={ICON_SIZE} />
      <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
    </button>
  )
}
