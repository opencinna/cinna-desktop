import { Inbox } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { describeUnreadable, useInboxList } from '../../hooks/useInbox'

const MAX_SHOWN = 99

/** A fixed-size top-bar control, available even when the sidebar is collapsed. */
export function InboxButton({ className = '' }: { className?: string }): React.JSX.Element {
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { data, isError } = useInboxList()
  const count = data?.entries.length ?? 0
  const active = activeView === 'inbox'
  /**
   * A partly read inbox keeps its count and loses its confidence.
   *
   * The number is still true — those asks are waiting — so hiding it behind a
   * `!` would trade a fact for a warning. What the badge cannot claim is that
   * the number is *all* of them, and the only place that can be said is the
   * accessible name, because the overlay is `aria-hidden` and is two digits
   * wide (`ux_rules.md` §10). A rejected query is the other thing entirely:
   * nothing was read, so there is no count to keep.
   */
  const partial = !isError && describeUnreadable(data?.unreadable ?? [])?.toLowerCase()
  const label = isError
    ? 'Inbox — could not be read'
    : partial
      ? count === 0
        ? `Inbox — ${partial}`
        : `Inbox — ${count} waiting, ${partial}`
      : count === 0
        ? 'Inbox'
        : `Inbox — ${count} waiting`

  return (
    <button
      type="button"
      onClick={() => setActiveView('inbox')}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`relative flex h-[29px] w-[29px] shrink-0 items-center justify-center aria-pressed:bg-[var(--color-accent)]/15 aria-pressed:text-[var(--color-accent)] ${className}`}
    >
      <Inbox size={15} aria-hidden="true" />
      {/* Overlay the count so updates never resize or move the header controls. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute -top-1 -right-1 flex h-3 w-5 items-center justify-center rounded-full text-[8px] leading-none font-semibold tabular-nums ${
          isError || partial
            ? 'bg-[var(--color-warning)] text-[var(--color-bg)]'
            : count > 0
              ? 'bg-[var(--color-accent)] text-[var(--color-bg)]'
              : ''
        }`}
      >
        {/*
          **A partial read with nothing local to show still has to look like
          something.** Keeping the count is the rule when there is one; at zero
          the same rule leaves an empty overlay on an unfilled badge — pixel for
          pixel a healthy, empty inbox — for the profile whose one bound service
          just went dark. That is the silent failure `ux_rules.md` §6 calls the
          worst outcome, on the control that exists to prevent it. So zero is
          the one case where the marker falls back to the failure glyph: there
          is no fact to protect, only a wrong impression to avoid.
        */}
        {isError || (partial && count === 0)
          ? '!'
          : count === 0
            ? ''
            : count > MAX_SHOWN
              ? `${MAX_SHOWN}+`
              : count}
      </span>
    </button>
  )
}
