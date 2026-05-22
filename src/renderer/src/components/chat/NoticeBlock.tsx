import { useState } from 'react'
import { Info } from 'lucide-react'

interface NoticeBlockProps {
  /** The notice text emitted by the agent (e.g. "Starting up the agent environment…"). */
  content: string
  /**
   * `true` while the notice is still streaming live — forces the expanded view
   * (no collapse affordance, since the user is actively reading the in-flight
   * ping). After the stream completes and the row persists, the parent re-renders
   * this component without `live`, which switches to the collapsed-dot default.
   */
  live?: boolean
  /**
   * Initial expand state when the notice is persisted (not `live`). Verbose mode
   * passes `true` so notices stay inline; compact mode passes `false` (or omits
   * it) so notices collapse to a dot the user can click to read.
   */
  defaultExpanded?: boolean
}

/**
 * Renders an agent-side `cinna.content_kind: 'notice'` part.
 *
 * - `live={true}`: streaming view — left-aligned Info+text row, no collapse.
 * - `live={false}` (default): persisted `agent_transition` row — starts in
 *   `defaultExpanded` state (compact mode passes `false` → collapsed dot;
 *   verbose mode passes `true` → expanded Info+text). Clicking toggles either
 *   direction.
 *
 * The live view and the expanded persisted view share the same styling so the
 * swap from streaming to persisted has no visual seam.
 */
export function NoticeBlock({ content, live, defaultExpanded }: NoticeBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false)

  if (live) {
    return (
      <div
        className="inline-flex items-start gap-1.5 px-2 py-1 rounded-md
          text-xs text-[var(--color-text-muted)] max-w-full"
      >
        <Info size={12} className="shrink-0 mt-0.5" />
        <span className="break-words">{content}</span>
      </div>
    )
  }

  if (!expanded) {
    // Native browser tooltip truncates anyway, and notices with newlines render
    // ugly inside a single-line tooltip. Cap to a one-line preview; the click
    // affordance owns the full read.
    const preview = content.length > 120 ? `${content.slice(0, 117)}…` : content
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Show agent notice"
        title={preview}
        className="group inline-flex items-center justify-center p-1 rounded-full
          hover:bg-[var(--color-bg-secondary)]/60 transition-colors"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-[var(--color-severity-info)]/70 group-hover:bg-[var(--color-severity-info)] transition-colors" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded(false)}
      aria-label="Hide agent notice"
      className="inline-flex items-start gap-1.5 px-2 py-1 rounded-md
        text-xs text-[var(--color-text-muted)]
        hover:text-[var(--color-text-secondary)]
        hover:bg-[var(--color-bg-secondary)]/60
        transition-colors max-w-full text-left"
    >
      <Info size={12} className="shrink-0 mt-0.5" />
      <span className="break-words">{content}</span>
    </button>
  )
}
