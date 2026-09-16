import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTaskList } from '../../hooks/useTaskList'
import { useOpenTask } from '../../hooks/useTasks'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeFromDate } from '../../utils/cinnaTime'
import { TaskStatusIcon } from './TaskStatusIcon'

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
 * ## Its own component, sharing `TaskList`'s query
 *
 * Same `useTaskList()` with no parent id, so the two surfaces cannot disagree
 * about what a root task is or pay twice to find out — and no `variant` prop on
 * `TaskList`, because the two differ in scale, row shape, page size, empty
 * copy and heading, which is a second component wearing the first one's name.
 * `TaskList` keeps the one job it still has: the Subtasks region on a task
 * page.
 *
 * ## The status leads, and the elastic part is last
 *
 * A row is where it stands, what it is, and when it last moved. The status is
 * an icon at the head rather than a spelled-out badge at the tail, because a
 * list is scanned and a page is read: ten rows of small capitals is a word the
 * eye has to get past to reach the title, and at a fixed 14 px every title
 * starts at the same left edge instead of ending at a right edge set by the
 * length of "in progress". See `TaskStatusIcon`.
 *
 * The time stays last for the reason the pill used to: it is the only part
 * whose width changes on its own — "3 minutes ago" becomes "1 hour ago" while
 * the user is reading — so nothing may sit after it that a five-second poll
 * could then shove sideways (`ux_rules.md` §1).
 */
const PAGE = 10

export function RecentTasks(): React.JSX.Element {
  const tasks = useTaskList()
  const openTask = useOpenTask()
  const now = useRelativeNow()
  const [visible, setVisible] = useState(PAGE)
  const rows = tasks.data?.tasks ?? []
  // The root list is read straight out of SQLite, so there is no half-failure
  // to report here: `refreshError` belongs to the children query `TaskList`
  // uses, where a remote refresh can fail under rows that are still true.
  const failed = tasks.isError

  /**
   * The order each row was first seen in, held for the life of the mount.
   *
   * The query is `ORDER BY updated_at DESC` re-run every five seconds, so
   * without this **any** task changing anywhere in the app — an agent writing
   * progress, a peer's row arriving over sync — jumps to the top and pushes
   * every row below it down by exactly one row, under whatever the pointer was
   * on (`ux_rules.md` §1). The list directly above this one spends twelve lines
   * of comment refusing to do that to a permission ask; a task row opening the
   * wrong task is a smaller harm than a permission answered by accident, but it
   * is the same movement and it has the same cure.
   *
   * The cost is that a task updated while this screen is open keeps its place
   * instead of rising, and a brand-new one appends at the end rather than the
   * top. Both resolve by leaving the Inbox and coming back, which is when the
   * order is taken again — the same bargain `InboxView` makes.
   */
  const order = useRef<string[]>([])
  const ordered = useMemo(() => {
    const byId = new Map(rows.map((task) => [task.id, task]))
    const known = new Set(order.current)
    const fresh = rows.filter((task) => !known.has(task.id))
    if (fresh.length > 0) order.current = [...order.current, ...fresh.map((task) => task.id)]
    return order.current.map((id) => byId.get(id)).filter((task) => task !== undefined)
  }, [rows])

  /**
   * Keep **Show more tasks** under the pointer that just pressed it.
   *
   * The rows it reveals are inserted below everything the user is reading, so
   * nothing above the button moves — but the button itself drops by the height
   * of ten rows (measured: 343 px in an 800 px window, which puts it 288 px
   * below the fold) and a task row slides into the pixels it left. A second
   * click then opens a task nobody chose.
   *
   * Scrolling by exactly the height that was added is allowed here where a
   * poll-driven shift would not be: it is the direct consequence of a gesture
   * the user made, it is what brings the rows they asked for into view, and it
   * leaves the control they are still pointing at where they left it.
   */
  const section = useRef<HTMLElement>(null)
  const grownFrom = useRef<number | null>(null)

  const showMore = (): void => {
    grownFrom.current = section.current?.getBoundingClientRect().height ?? null
    setVisible((count) => count + PAGE)
  }

  useLayoutEffect(() => {
    const before = grownFrom.current
    grownFrom.current = null
    if (before === null || !section.current) return
    const grew = section.current.getBoundingClientRect().height - before
    const scroller = section.current.closest('[data-inbox-scroll]')
    if (scroller && grew > 0) scroller.scrollTop += grew
  }, [visible])

  return (
    <section ref={section} aria-label="Recent tasks" className="space-y-3">
      {/*
        The visible name and the accessible one are the same words (§10), at
        the size every other section title in the app is set at — `TaskView`'s
        `Section`, one click away through any of these rows. At `text-base` it
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
              <button
                type="button"
                /*
                  **The status is in the name because it is on the row**
                  (`ux_rules.md` §10). An `aria-label` replaces the contents it
                  sits on, so the title alone announced a list whose whole
                  point — where each piece of work stands — was visible to
                  everyone except the reader who most depends on it being said.
                  The pill's own wording, so the two cannot diverge.

                  The relative time is deliberately left out: it is the one
                  part of the row that rewrites itself while the list sits
                  there, and a name that changes under a screen reader every
                  minute is worse than one that omits a detail the user can
                  reach by reading the row.
                */
                aria-label={`${task.title} — ${task.status.replace(/_/g, ' ')}`}
                onClick={() => openTask(task.id)}
                /*
                  One line per task, and the height says so: `leading-5` is the
                  13 px scale's own leading, so the row is that plus `py-1` and
                  nothing else — a height derived from the type rather than a
                  pixel count picked to look right, which is what keeps it in
                  step if the scale ever moves (`ux_rules.md` §12).
                */
                className="w-full flex items-center gap-2.5 px-2 py-1 rounded text-left leading-5 hover:bg-[var(--color-bg-hover)]"
              >
                {/*
                  The status leads the row rather than trailing it. In a list,
                  where it stands is what the eye sorts by — and an icon at a
                  fixed 14 px gives every row the same left edge for its title,
                  where a trailing word set the title's *right* edge differently
                  on every row depending on how long "in progress" is.
                */}
                <TaskStatusIcon status={task.status} />
                <span
                  className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text)]"
                  title={task.title}
                >
                  {task.title}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">
                  {formatRelativeFromDate(task.updatedAt, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {ordered.length > visible && (
        <button
          type="button"
          onClick={showMore}
          className="px-2 text-[13px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
        >
          Show more tasks
        </button>
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
