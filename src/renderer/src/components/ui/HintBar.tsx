import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useHintsEnabled } from '../../hooks/useHintsEnabled'
import { useHintContext } from '../../hooks/useHintContext'
import { useHintRotation } from '../../hooks/useHintRotation'
import { useHintsStore } from '../../stores/hints.store'
import { hintText, isHintKey, resolveKey, type Hint } from '../../constants/hints'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

/** Crossfade half-life — out, swap, in. */
const FADE_MS = 180

interface HintBarProps {
  /** Primary agent picked on the new-chat screen — sources the `#` / `/` gates. */
  selectedAgent?: AgentData | null
  /** Drives the double-ESC hint, which only applies with agents selected. */
  pendingAgentCount?: number
}

/**
 * One-line rotating tip bar stuck to the bottom of the new-chat screen.
 *
 * Purely presentational: eligibility comes from `useHintContext`, sequencing
 * from `useHintRotation`. This component owns the crossfade and the markup.
 *
 * Deliberately not an `aria-live` region: a polite live region firing every
 * seven seconds is hostile to screen-reader users. It's a `role="note"` with a
 * stable label — readable on demand, never announced unprompted.
 */
export function HintBar({
  selectedAgent = null,
  pendingAgentCount = 0
}: HintBarProps): React.JSX.Element | null {
  const enabled = useHintsEnabled()
  const ctx = useHintContext(selectedAgent, pendingAgentCount)
  const silence = useHintsStore((s) => s.silence)
  const { hint, isContextual, hoverProps } = useHintRotation(enabled, 'new-chat', ctx)

  // Crossfade: fade the outgoing line out, swap the content, fade back in.
  const [shown, setShown] = useState<Hint | null>(hint)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (hint?.id === shown?.id) {
      // Re-entry guard. If `hint` changed away and back inside FADE_MS, the
      // cleanup below already cancelled the timer that would have restored
      // visibility — without this the bar would stay blank until the next
      // rotation tick.
      if (!visible) setVisible(true)
      return
    }
    setVisible(false)
    const t = setTimeout(() => {
      setShown(hint)
      setVisible(true)
    }, FADE_MS)
    return () => clearTimeout(t)
  }, [hint, shown, visible])

  if (!enabled) return null

  return (
    // The bar overlays the bottom of the screen; `MainArea` reserves matching
    // space via `useHintsEnabled` so a tall composer never grows underneath it.
    <div
      className="absolute bottom-0 left-0 right-0 px-4 pb-1 pointer-events-none"
      aria-hidden={!shown}
    >
      <div
        {...hoverProps}
        role="note"
        aria-label="Hints"
        className="group relative w-full max-w-3xl mx-auto h-6 flex items-center justify-center
          pointer-events-auto"
      >
        <div
          className={`flex items-center gap-1 text-[11px] leading-none text-center select-none
            transition-opacity duration-150 motion-reduce:transition-none
            ${visible && shown ? 'opacity-100' : 'opacity-0'}
            ${isContextual ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}
          title={shown ? hintText(shown) : undefined}
        >
          {shown?.segments.map((segment, i) =>
            isHintKey(segment) ? (
              <kbd
                key={i}
                className="inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[10px]
                  bg-[var(--color-accent)]/12 text-[var(--color-accent)]
                  border border-[var(--color-accent)]/20"
              >
                {resolveKey(segment.key)}
              </kbd>
            ) : (
              <span key={i} className="whitespace-pre">
                {segment}
              </span>
            )
          )}
        </div>

        {shown && (
          <button
            type="button"
            onClick={silence}
            title="Hide hints for now — turn them off for good in Settings → Features"
            aria-label="Hide hints for this session"
            className="absolute right-0 opacity-0 group-hover:opacity-100 p-0.5 rounded
              transition-opacity motion-reduce:transition-none
              text-[var(--color-text-muted)] hover:text-[var(--color-text)]
              hover:bg-[var(--color-bg-hover)]"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  )
}
