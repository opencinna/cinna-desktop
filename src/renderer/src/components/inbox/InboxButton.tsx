import { Inbox } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useInboxList } from '../../hooks/useInbox'

const MAX_SHOWN = 99

/** A fixed-size top-bar control, available even when the sidebar is collapsed. */
export function InboxButton({ className = '' }: { className?: string }): React.JSX.Element {
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { data, isError } = useInboxList()
  const count = data?.length ?? 0
  const active = activeView === 'inbox'
  // A failed read must remain distinguishable from an empty inbox.
  const label = isError
    ? 'Inbox — could not be read'
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
          isError
            ? 'bg-[var(--color-warning)] text-[var(--color-bg)]'
            : count > 0
              ? 'bg-[var(--color-accent)] text-[var(--color-bg)]'
              : ''
        }`}
      >
        {isError ? '!' : count === 0 ? '' : count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}
      </span>
    </button>
  )
}
