import { useState } from 'react'
import { Info } from 'lucide-react'

interface NoticeBlockProps {
  /** The notice text emitted by the agent (e.g. "Starting up the agent environment…"). */
  content: string
}

/**
 * Collapsed view of a persisted `agent_transition` row (a Cinna
 * `cinna.content_kind: 'notice'` part that the streaming pipeline saved as
 * its own message row).
 *
 * While the notice is still streaming live it renders in expanded
 * system-message form (handled in MessageStream — see the `stream-notice`
 * branch). Once the stream completes and the row lands in the DB, this
 * collapsed-by-default pill takes over so the notice no longer eats
 * vertical space in the transcript. Clicking the dot reveals the original
 * notice text — same muted system-message styling — so the user can still
 * inspect what the agent told them if they need to.
 */
export function NoticeBlock({ content }: NoticeBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  if (!expanded) {
    // Native browser tooltip truncates anyway, and notices with newlines render
    // ugly inside a single-line tooltip. Cap to a one-line preview; the click
    // affordance owns the full read.
    const preview = content.length > 120 ? `${content.slice(0, 117)}…` : content
    return (
      <div className="flex justify-center">
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
      </div>
    )
  }

  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={() => setExpanded(false)}
        aria-label="Hide agent notice"
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40
          px-4 py-2.5 max-w-md text-center
          flex items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]
          hover:text-[var(--color-text-secondary)] transition-colors"
      >
        <Info size={13} />
        <span>{content}</span>
      </button>
    </div>
  )
}
