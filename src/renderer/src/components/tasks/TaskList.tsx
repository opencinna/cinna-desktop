import { useState } from 'react'
import { useTaskList } from '../../hooks/useTaskList'
import { useOpenTask } from '../../hooks/useTasks'
import { useUIStore } from '../../stores/ui.store'
import { TaskStatusPill } from './TaskStatusPill'

export function TaskList({ parentTaskId }: { parentTaskId?: string }): React.JSX.Element {
  const tasks = useTaskList(parentTaskId)
  const openTask = useOpenTask()
  const activeTaskId = useUIStore((state) => state.activeTaskId)
  const [visible, setVisible] = useState(20)
  const title = parentTaskId ? 'Subtasks' : 'Tasks'
  const failed = tasks.isError || !!tasks.data?.refreshError
  const rows = tasks.data?.tasks ?? []
  return (
    <section aria-label={title} className="px-1.5 py-2">
      <h2 className="px-1.5 mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h2>
      {(tasks.isPending || (!tasks.data?.refreshed && !failed && !rows.length)) && <p className="px-1.5 text-xs text-[var(--color-text-muted)]">Loading tasks…</p>}
      {tasks.isSuccess && tasks.data.refreshed && !failed && rows.length === 0 && <p className="px-1.5 text-xs text-[var(--color-text-muted)]">{parentTaskId ? 'No subtasks.' : 'No tasks yet.'}</p>}
      <ul className="list-none m-0 p-0 space-y-0.5">
        {rows.slice(0, visible).map((task) => (
          <li key={task.id}>
            <button type="button" aria-label={task.title} onClick={() => openTask(task.id)}
              className={`w-full flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 rounded text-left hover:bg-[var(--color-bg-hover)] ${activeTaskId === task.id ? 'bg-[var(--color-bg-hover)]' : ''}`}>
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text)]" title={task.title}>{task.title}</span>
              <TaskStatusPill status={task.status} />
            </button>
          </li>
        ))}
      </ul>
      {rows.length > visible && (
        <button type="button" onClick={() => setVisible((count) => count + 20)}
          className="px-1.5 py-1 text-xs font-medium text-[var(--color-accent)]">Show more tasks</button>
      )}
      <div className="min-h-5 px-1.5 text-[11px] text-[var(--color-text-muted)]" role={failed ? 'alert' : undefined}>
        {failed && <>{tasks.data?.refreshError ?? 'Tasks could not be refreshed.'} <button type="button" onClick={() => void tasks.refetch()} className="font-medium text-[var(--color-accent)]">Try again</button></>}
      </div>
    </section>
  )
}
