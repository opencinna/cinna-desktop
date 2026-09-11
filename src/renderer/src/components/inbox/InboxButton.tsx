import { Inbox } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useInboxList } from '../../hooks/useInbox'

/** Past this the slot would have to grow, so it says "more" instead of a number. */
const MAX_SHOWN = 99

/**
 * The Inbox entry in the sidebar — the one door into everything waiting on a
 * human, from any agent, in any chat, whether or not that chat is open.
 *
 * It sits **above** the tab list rather than inside it because an ask does not
 * belong to a tab: the job that raised it is under Jobs, its chat is under
 * Chats, and the whole point of the inbox is that the user does not have to
 * know which. So it is visible from all four, in the same place.
 *
 * **The count lives in a fixed-width slot.** It changes on its own, while the
 * user is reading or clicking something else in this sidebar; a slot that grew
 * from one digit to two would move the row's label — and at 0, its own hit
 * target — underneath them (`ux_rules.md` §1). The slot is the width of the
 * widest thing it can hold and is present at every count, including none.
 */
export function InboxButton(): React.JSX.Element {
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { data, isError } = useInboxList()
  const count = data?.length ?? 0
  const active = activeView === 'inbox'
  // **A failed read is not zero.** `data` is undefined on an error too, so a
  // badge that only counted would report "nothing waiting" for an agent that
  // is parked — and would be the last place anyone looked for the reason. The
  // slot is the same width either way, so saying so moves nothing.
  const unreadable = isError

  return (
    <div className="px-1.5 pt-1.5 pb-0.5">
      <button
        type="button"
        onClick={() => setActiveView('inbox')}
        // The visible name branches with the count, so the announced one
        // branches with it (`ux_rules.md` §10) — the badge itself is decoration
        // that a reader would otherwise hear as a bare number.
        aria-label={
          unreadable
            ? 'Inbox — could not be read'
            : count === 0
              ? 'Inbox'
              : `Inbox — ${count} waiting`
        }
        aria-pressed={active}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
          active
            ? 'app-nav-active text-[var(--color-text)]'
            : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
        }`}
      >
        <Inbox size={14} className="shrink-0" />
        <span className="flex-1 text-left">Inbox</span>
        <span
          aria-hidden="true"
          className={`w-7 shrink-0 text-right tabular-nums text-[10px] ${
            unreadable
              ? 'text-[var(--color-warning)] font-semibold'
              : count > 0
                ? 'text-[var(--color-accent)] font-semibold'
                : ''
          }`}
        >
          {unreadable ? '!' : count === 0 ? '' : count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}
        </span>
      </button>
    </div>
  )
}
