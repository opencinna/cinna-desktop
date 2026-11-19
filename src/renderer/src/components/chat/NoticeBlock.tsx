import { AlertTriangle, Info } from 'lucide-react'
import type { NoticeTone } from '../../../../shared/messageParts'
import { useTranscriptDisclosure } from './transcriptExpansion'

/** Added to a live warning only: once the turn is over there is nothing to stop. */
export const LIVE_WARNING_HINT = 'Stop ends the turn.'

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
  /**
   * `'warning'` (a provider error, a turn gone silent): drawn in the warning
   * colour with a triangle, live and persisted alike, and never collapsed —
   * there is no toggle, so `defaultExpanded` does not apply. Default `'info'`.
   */
  tone?: NoticeTone
  /**
   * A live warning's " Stop ends the turn." — true only while the turn still
   * runs (the streamed blocks outlive the turn until its saved rows land).
   * Defaults to `live`.
   */
  stoppable?: boolean
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
 *
 * A `tone="warning"` notice is one row, the same live and persisted: the
 * warning colour, a triangle, readable text, and no collapse in either mode.
 */
export function NoticeBlock({ content, live, defaultExpanded, tone, stoppable = live }: NoticeBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useTranscriptDisclosure(defaultExpanded ?? false)

  if (tone === 'warning') {
    // The saved text says what happened; how to act on it is only true while
    // the turn runs, so the live row alone adds it. No role here: the
    // transcript's one live region reads a new warning out
    // (`NoticeWarningAnnouncer`), and a saved one is history.
    return (
      <div
        data-notice-tone="warning"
        // `pl-1`: the triangle starts where an info notice's dot does (its
        // button's `p-1`), so a warning between two dots lines up with them.
        className="inline-flex items-start gap-1.5 pl-1 pr-2 py-1 rounded-md
          text-xs text-[var(--color-severity-warning-text)] max-w-full"
      >
        <AlertTriangle size={12} className="shrink-0 mt-0.5 text-[var(--color-warning)]" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span data-notice-text>{content}</span>
          {live && stoppable && <span data-notice-live-hint>{` ${LIVE_WARNING_HINT}`}</span>}
        </span>
      </div>
    )
  }

  if (live) {
    return (
      <div
        className="inline-flex items-start gap-1.5 px-2 py-1 rounded-md
          text-xs text-[var(--color-text-muted)] max-w-full"
      >
        <Info size={12} className="shrink-0 mt-0.5" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{content}</span>
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
      <span className="min-w-0 [overflow-wrap:anywhere]">{content}</span>
    </button>
  )
}
