import { useSessionActivity } from '../../hooks/useSessionActivity'
import { useSessionActivityStop } from '../../hooks/useSessionActivityStop'
import { ChatTasksBadge } from './ChatTasksBadge'
import { SessionActivityBadge } from './SessionActivityBadges'

/**
 * Live meta information about this chat's session, under the composer, to the
 * left of the router badge. Each badge decides on its own whether it has
 * anything to say; a new kind of session meta joins here.
 *
 * **Order is the layout rule** (`ux_rules.md` §1). The cluster is right-aligned,
 * so a badge that appears pushes only what is to its left. The badges that come
 * and go with running work (Agents, Background) are therefore leftmost, and
 * Tasks — which stays once a chat has one — sits next to the router badge.
 *
 * Only for a chat that exists: an unsent chat has no session and no tasks.
 */
/**
 * Below this composer-row width Agents and Background collapse into one
 * Activity badge. Measured at the 800 px minimum window with the sidebar open,
 * the row is 473 px; with it collapsed, or at 1280 px, 780 px and more.
 */
const SPLIT = '@max-[40rem]/composer:hidden'
const COLLAPSED = '@min-[40rem]/composer:hidden'

export function SessionMetaBadges({ chatId }: { chatId: string }): React.JSX.Element {
  const activity = useSessionActivity(chatId)
  const items = activity.data?.items ?? []
  // Here, not in a popover row: the rows unmount while a stop is in flight.
  const stop = useSessionActivityStop(chatId)
  return (
    <div className="flex items-center gap-1.5" data-testid="session-meta-badges">
      {/*
        Two badges where the composer row is wide, one where it is narrow.
        A container query on the row (ChatInput's `@container/composer`), not
        a measurement: pure CSS cannot flip back and forth as the badge it
        swaps changes the width it was measured against.
      */}
      <SessionActivityBadge kind="subagent" items={items} stop={stop} className={SPLIT} />
      <SessionActivityBadge kind="background" items={items} stop={stop} className={SPLIT} />
      <SessionActivityBadge kind="all" items={items} stop={stop} className={COLLAPSED} />
      <ChatTasksBadge chatId={chatId} />
    </div>
  )
}
