import type { TaskDto } from '../../../../shared/tasks'
import { TASK_STATUS_CATEGORY_LABEL, taskStatusCategory, type TaskStatusCategory } from '../../../../shared/taskStatus'
import { TaskRow } from './TaskRow'
import { useTaskRowsInPlace } from './useTaskRowsInPlace'
import { LIST_SECTION_ORDER } from './tasksViewModel'

/** How many finished tasks show before Show more, as in Recent tasks. */
const DONE_PAGE = 10
/** Every open section shows all its rows; only Done pages. */
const ALL = Number.MAX_SAFE_INTEGER

/**
 * The Tasks view as a list: one section per category, in the order the user
 * acts on them — Waiting, In progress, Ready, Backlog, Done.
 *
 * **Every section is always there, even at 0.** A poll that brings the first
 * waiting task must not insert a section above the one the reader is in
 * (`ux_rules.md` §1); a count changing in a header moves nothing.
 *
 * Rows are `TaskRow`, the row every task list uses (§13), held in the order
 * they were first seen for the mount (`useTaskRowsInPlace`): a task that
 * changes category leaves one section and appends to the end of another.
 */
export function TasksList({ tasks, showAssignee = false }: {
  tasks: readonly TaskDto[]
  /** Name each row's agent — only while the list mixes agents (the filter is "All agents"). */
  showAssignee?: boolean
}): React.JSX.Element {
  const byCategory = new Map<TaskStatusCategory, TaskDto[]>(LIST_SECTION_ORDER.map((category) => [category, []]))
  for (const task of tasks) {
    const category = taskStatusCategory(task.status)
    if (category) byCategory.get(category)!.push(task)
  }
  return (
    <div className="space-y-5">
      {LIST_SECTION_ORDER.map((category) => (
        <TasksListSection key={category} category={category} tasks={byCategory.get(category)!} showAssignee={showAssignee} />
      ))}
    </div>
  )
}

function TasksListSection({ category, tasks, showAssignee }: {
  category: TaskStatusCategory
  tasks: TaskDto[]
  showAssignee: boolean
}): React.JSX.Element {
  const label = TASK_STATUS_CATEGORY_LABEL[category]
  const page = category === 'closed' ? DONE_PAGE : ALL
  const { ordered, visible, expanded, showMore, sectionRef } = useTaskRowsInPlace(tasks, page, '[data-tasks-scroll]')
  return (
    <section ref={sectionRef} aria-label={label} className="space-y-1">
      <h2 className="flex items-center gap-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
        <span className="font-normal tabular-nums">{ordered.length}</span>
      </h2>
      {ordered.length > 0 && (
        <ul className="list-none m-0 p-0">
          {ordered.slice(0, visible).map((task) => (
            <li key={task.id}>
              <TaskRow task={task} showAssignee={showAssignee} />
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
    </section>
  )
}
