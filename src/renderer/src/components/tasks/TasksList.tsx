import { useMemo } from 'react'
import type { TaskDto } from '../../../../shared/tasks'
import { TASK_STATUS_CATEGORY_LABEL, taskStatusCategory, type TaskStatusCategory } from '../../../../shared/taskStatus'
import { TaskRow } from './TaskRow'
import { useTaskRowsInPlace } from './useTaskRowsInPlace'
import { LIST_SECTION_ORDER } from './tasksViewModel'

/** How many finished tasks show before Show more, as in the Recent list. */
const DONE_PAGE = 10
/** How many Recent rows show before Show more. */
const RECENT_PAGE = 10
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

/**
 * The Tasks view's **Recent** grouping: every task the list holds, in one
 * section, the last changed first — what the Inbox's Recent tasks used to be.
 *
 * Last changed first is the order a row is **first seen** in, not a sort re-run
 * on every poll (`useTaskRowsInPlace`): a task an agent is writing to while the
 * list is open keeps its place rather than jumping to the top under the pointer
 * (`ux_rules.md` §1), and a task new to the list joins at the end. The order is
 * taken again on the next mount — the caller remounts it (a `key`) when the
 * agent filter changes, since another agent's rows were never seen here.
 * Ten rows, then Show more, like Done in the category list.
 */
export function TasksRecentList({ tasks, showAssignee = false }: {
  tasks: readonly TaskDto[]
  showAssignee?: boolean
}): React.JSX.Element {
  const byLastChange = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [tasks]
  )
  return <TasksListRows label="Recent tasks" tasks={byLastChange} page={RECENT_PAGE} showAssignee={showAssignee} />
}

function TasksListSection({ category, tasks, showAssignee }: {
  category: TaskStatusCategory
  tasks: TaskDto[]
  showAssignee: boolean
}): React.JSX.Element {
  const label = TASK_STATUS_CATEGORY_LABEL[category]
  const page = category === 'closed' ? DONE_PAGE : ALL
  return <TasksListRows label={label} tasks={tasks} page={page} showAssignee={showAssignee} />
}

/** One titled section of rows, held in first-seen order, paged by `page`. */
function TasksListRows({ label, tasks, page, showAssignee }: {
  label: string
  tasks: TaskDto[]
  page: number
  showAssignee: boolean
}): React.JSX.Element {
  const { ordered, head, rest, more, expanded, showMore } = useTaskRowsInPlace(tasks, page)
  return (
    <section aria-label={label} className="space-y-1">
      <h2 className="flex items-center gap-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
        <span className="font-normal tabular-nums">{ordered.length}</span>
      </h2>
      {head.length > 0 && (
        <ul className="list-none m-0 p-0">
          {head.map((task) => (
            <li key={task.id}>
              <TaskRow task={task} showAssignee={showAssignee} />
            </li>
          ))}
        </ul>
      )}
      {/* The slot keeps its line once pressed; the rest goes below it (`useTaskRowsInPlace`). */}
      {more ? (
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
      {rest.length > 0 && (
        <ul className="list-none m-0 p-0">
          {rest.map((task) => (
            <li key={task.id}>
              <TaskRow task={task} showAssignee={showAssignee} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
