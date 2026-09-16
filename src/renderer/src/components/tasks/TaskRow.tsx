import type { TaskDto } from '../../../../shared/tasks'
import { useOpenTask } from '../../hooks/useTasks'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeFromDate } from '../../utils/cinnaTime'
import { TaskStatusIcon } from './TaskStatusIcon'

/**
 * One task as a list row: where it stands, what it is, and when it last moved.
 * Clicking it opens the task page. The caller owns the list around it.
 *
 * ## The status leads, and the elastic part is last
 *
 * The status is an icon at the head rather than a spelled-out badge at the
 * tail, because a list is scanned and a page is read: ten rows of small
 * capitals is a word the eye has to get past to reach the title, and at a fixed
 * 14 px every title starts at the same left edge instead of ending at a right
 * edge set by the length of "in progress". See `TaskStatusIcon`.
 *
 * The time stays last for the reason the pill used to: it is the only part
 * whose width changes on its own — "3 minutes ago" becomes "1 hour ago" while
 * the user is reading — so nothing may sit after it that a five-second poll
 * could then shove sideways (`ux_rules.md` §1).
 */
export function TaskRow({
  task
}: {
  task: Pick<TaskDto, 'id' | 'title' | 'status' | 'updatedAt'>
}): React.JSX.Element {
  const openTask = useOpenTask()
  const now = useRelativeNow()
  return (
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
  )
}
