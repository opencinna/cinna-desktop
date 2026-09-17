import { useTaskList } from '../../hooks/useTaskList'
import { TaskRow } from './TaskRow'
import { useTaskRowsInPlace } from './useTaskRowsInPlace'

/**
 * The recent tasks, under the asks on the Inbox screen.
 *
 * ## Why it is here and not in the Jobs sidebar
 *
 * A task is **FYI structure**: nobody opens this app to start one, they are
 * what a job run or a conversation leaves behind. In the sidebar it sat under
 * the jobs list competing for height with the one list in that panel the user
 * does act on, at the sidebar's own `text-[10px]` chrome scale. Here it is the
 * second half of the screen someone opened on purpose to see what their work
 * is doing, at that screen's scale (`ux_rules.md` §12 — one type scale per
 * surface).
 *
 * ## Its own component, sharing `TaskList`'s query and row
 *
 * Same `useTaskList()` with no parent id, so the two surfaces cannot disagree
 * about what a root task is or pay twice to find out. Both render `TaskRow`
 * through `useTaskRowsInPlace`; what differs — scale, page size, empty copy,
 * the half-failed remote refresh only children have — is why `TaskList` (a
 * task page's Subtasks) is a second component rather than a `variant` here.
 *
 * ## The row is `TaskRow`
 *
 * Status icon, title, relative time last — its own component so the chat
 * composer's Tasks popover can share it without a `variant` prop here.
 */
const PAGE = 10

export function RecentTasks(): React.JSX.Element {
  const tasks = useTaskList()
  const rows = tasks.data?.tasks ?? []
  // The root list is read straight out of SQLite, so there is no half-failure
  // to report here: `refreshError` belongs to the children query `TaskList`
  // uses, where a remote refresh can fail under rows that are still true.
  const failed = tasks.isError

  // Fixed order and an in-place Show more — see `useTaskRowsInPlace`.
  const { ordered, visible, expanded, showMore, sectionRef } = useTaskRowsInPlace(
    rows,
    PAGE,
    '[data-inbox-scroll]'
  )

  return (
    <section ref={sectionRef} aria-label="Recent tasks" className="space-y-3">
      {/*
        The visible name and the accessible one are the same words (§10), at
        section-title size rather than page-title size: at `text-base` it
        computed to the same 17px/600 as the `Inbox` h1 above the rule, which
        made it a second page title and the screen read as two screens rather
        than one screen with a second section (§12).
      */}
      <h2 className="text-xs font-semibold text-[var(--color-text-secondary)]">Recent tasks</h2>

      {tasks.isPending ? (
        <p className="text-[13px] text-[var(--color-text-muted)]">Loading…</p>
      ) : ordered.length === 0 && !failed ? (
        <div className="space-y-1">
          <p className="text-[13px] text-[var(--color-text-muted)]">No tasks yet.</p>
          {/*
            Not "Work a job or a conversation started shows up here." — the
            sentence opens on a bare "Work" and reads as an instruction until
            the verb turns up four words later, and it is the first thing a
            first-run user is told about tasks (`ux_rules.md` §7). It also does
            not repeat the line above it: that one says there are none, this one
            says where they come from.
          */}
          <p className="text-[11px] text-[var(--color-text-muted)] opacity-80">
            One arrives when a job runs, or when an agent stops to ask you something.
          </p>
        </div>
      ) : (
        /*
          No gap between rows: at one line each they read as a list, and 2 px of
          air between them only makes ten rows taller without making any one of
          them easier to land on. The hover fill is what separates them.
        */
        <ul className="list-none m-0 p-0">
          {ordered.slice(0, visible).map((task) => (
            <li key={task.id}>
              <TaskRow task={task} />
            </li>
          ))}
        </ul>
      )}

      {ordered.length > visible ? (
        <button
          type="button"
          onClick={showMore}
          className="px-2 text-[13px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
        >
          Show more tasks
        </button>
      ) : expanded && (
        <p className="px-2 text-[13px] text-[var(--color-text-muted)]">All {ordered.length} shown</p>
      )}

      {/*
        Below the list, never above it: the read re-runs every five seconds and
        a line appearing over the rows would move the one the user is reaching
        for (`ux_rules.md` §1). The rows above are the last good read and are
        still openable.
      */}
      {failed && (
        <p className="px-2 text-[11px] text-[var(--color-text-muted)]" role="alert">
          Tasks could not be read.{' '}
          <button
            type="button"
            onClick={() => void tasks.refetch()}
            className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
          >
            Try again
          </button>
        </p>
      )}
    </section>
  )
}
