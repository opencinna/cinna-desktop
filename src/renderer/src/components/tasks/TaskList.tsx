import { useTaskList } from '../../hooks/useTaskList'
import { TaskRow } from './TaskRow'
import { useTaskRowsInPlace } from './useTaskRowsInPlace'

const PAGE = 20

/**
 * A task page's Subtasks: the same `TaskRow` the Inbox's Recent tasks uses,
 * with the same fixed order and in-place Show more (`useTaskRowsInPlace`), at
 * the task page's own 12/11 scale (`compact`, `ux_rules.md` §12).
 *
 * Unlike Recent tasks, this read goes through the remote parent's refresh, so it
 * can half-fail: saved rows stay openable above a retry line, and an unconfirmed
 * empty read never claims there are no subtasks. The caller keys it by parent,
 * so the held order is taken again for each task.
 *
 * ## A task with no subtasks shows no section
 *
 * Most tasks have none, and "Subtasks / No subtasks." on every one of them is a
 * heading over nothing. The list stays **mounted** all the same, because its
 * read is also the remote refresh that discovers a bound parent's children —
 * and `expected` (the task's saved count) can be stale for exactly that task.
 * So the section renders once it has rows, while rows it expects are loading,
 * or whenever the read failed; otherwise nothing. It is the last block on the
 * page, so appearing late moves nothing but the stale-read line below it.
 */
export function TaskList({
  parentTaskId,
  expected
}: {
  parentTaskId: string
  /** The task's saved subtask count says there are some. */
  expected: boolean
}): React.JSX.Element | null {
  const tasks = useTaskList({ parentTaskId })
  const failed = tasks.isError || !!tasks.data?.refreshError
  const rows = tasks.data?.tasks ?? []
  const { ordered, visible, expanded, showMore, sectionRef } = useTaskRowsInPlace(
    rows,
    PAGE,
    '[data-task-scroll]'
  )
  // A failed read is not an empty one: its retry line needs the section.
  if (rows.length === 0 && !expected && !failed) return null
  return (
    <section ref={sectionRef} aria-label="Subtasks" className="space-y-2 pt-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Subtasks</h2>
      {(tasks.isPending || (!tasks.data?.refreshed && !failed && !rows.length)) && (
        <p className="text-xs text-[var(--color-text-muted)]">Loading subtasks…</p>
      )}
      {tasks.isSuccess && tasks.data.refreshed && !failed && rows.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">No subtasks.</p>
      )}
      {ordered.length > 0 && (
        <ul className="list-none m-0 p-0">
          {ordered.slice(0, visible).map((task) => (
            <li key={task.id}>
              <TaskRow task={task} size="compact" />
            </li>
          ))}
        </ul>
      )}
      {ordered.length > visible ? (
        <button
          type="button"
          onClick={showMore}
          className="text-xs font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
        >
          Show more subtasks
        </button>
      ) : expanded && (
        <p className="text-xs text-[var(--color-text-muted)]">All {ordered.length} shown</p>
      )}
      {/* Below the rows, never above them: the read re-runs every five seconds. */}
      {failed && (
        <p className="text-[11px] text-[var(--color-text-muted)]" role="alert">
          {tasks.data?.refreshError ?? 'Subtasks could not be refreshed.'}{' '}
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
