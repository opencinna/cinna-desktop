import { useMemo, useState } from 'react'
import { Columns3, List, Loader2, Plus, Search } from 'lucide-react'
import { useTaskList } from '../../hooks/useTaskList'
import { useAgents } from '../../hooks/useAgents'
import { useCreateTask, useOpenTask } from '../../hooks/useTasks'
import { useUIStore, type TasksViewMode } from '../../stores/ui.store'
import { TasksList } from './TasksList'
import { TasksBoard } from './TasksBoard'
import { NewTaskDialog } from './TaskFormDialog'
import { ALL_AGENTS, UNASSIGNED, agentFilterOptions, matchesTaskFilters, type TaskAgentFilter } from './tasksViewModel'

const MODES: readonly { value: TasksViewMode; label: string; Icon: typeof List }[] = [
  { value: 'list', label: 'List', Icon: List },
  { value: 'board', label: 'Board', Icon: Columns3 }
]

const CONTROL =
  'h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-xs text-[var(--color-text)] ' +
  'focus:border-[var(--color-accent)] focus:outline-none'

/**
 * Every root task, as a list grouped by category or as a board — the
 * top bar's Tasks button opens it, and like the Inbox it belongs to no tab.
 *
 * Controls first, in one row (`ux_rules.md` §2): the title, List | Board
 * (remembered), the agent filter, a title search and **New task**, the one
 * primary action. A refused board move says so in one line laid over the gap
 * under the controls — absolutely placed, so neither the controls nor the
 * board move when it comes and goes (§1). Archived tasks are not here: the
 * root query leaves them out.
 *
 * List and board share one width, wide enough for the board's five columns,
 * so switching between them moves none of the controls.
 *
 * The New task mutation is owned here, not by the dialog, so the hook-level
 * `onCreated` that closes the dialog and opens the task runs even though the
 * dialog unmounts on the way (§5).
 */
export function TasksView(): React.JSX.Element {
  const mode = useUIStore((s) => s.tasksViewMode)
  const setMode = useUIStore((s) => s.setTasksViewMode)
  const tasks = useTaskList({ rootOnly: true })
  const { data: agents } = useAgents()
  const openTask = useOpenTask()
  const [agent, setAgent] = useState<TaskAgentFilter>(ALL_AGENTS)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const create = useCreateTask({
    onCreated: (task) => {
      setCreating(false)
      openTask(task.id)
    }
  })

  const rows = useMemo(() => tasks.data?.tasks ?? [], [tasks.data])
  const agentName = (id: string): string | undefined => agents?.find((entry) => entry.id === id)?.name
  const agentOptions = agentFilterOptions(rows, agentName)
  const visible = useMemo(() => rows.filter((task) => matchesTaskFilters(task, agent, search)), [rows, agent, search])
  const empty = !tasks.isPending && rows.length === 0 && !tasks.isError
  /** Tasks exist, the filters leave none: one line instead of five empty sections. */
  const noMatch = rows.length > 0 && visible.length === 0

  return (
    <div data-tasks-scroll className="flex-1 overflow-y-auto pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      <div data-sidebar-band-limit className="w-full max-w-7xl mx-auto px-6 py-6 space-y-4">
        {/*
          One row at every width (§2): at the 800 px minimum, beside the
          sidebar, the switch drops its words for its icons (the name stays,
          in aria-label and title) and the search shrinks first.
        */}
        <header className="@container relative flex items-center gap-2">
          <h1 className="mr-1 shrink-0 text-base font-semibold text-[var(--color-text)]">Tasks</h1>
          <div role="group" aria-label="Tasks layout" className="flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5">
            {MODES.map(({ value, label, Icon }) => (
              <button key={value} type="button" aria-pressed={mode === value} aria-label={label} title={label}
                onClick={() => { setMode(value); setMoveError(null) }}
                className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${mode === value ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                <Icon size={12} aria-hidden="true" />
                <span className="hidden @2xl:inline">{label}</span>
              </button>
            ))}
          </div>
          <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)}
            className={`${CONTROL} w-28 shrink-0 px-2 @2xl:w-40`}>
            <option value={ALL_AGENTS}>All agents</option>
            {agentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            {agent !== ALL_AGENTS && agent !== UNASSIGNED && !agentOptions.some((option) => option.value === agent) && (
              <option value={agent}>{agentName(agent.slice('agent:'.length)) ?? 'Agent'}</option>
            )}
            <option value={UNASSIGNED}>No agent</option>
          </select>
          {/* min-w-24: the placeholder whole at 800 px beside the sidebar, with the row still one line. */}
          <label className="relative flex min-w-24 flex-1 items-center">
            <Search size={12} aria-hidden="true" className="pointer-events-none absolute left-2 text-[var(--color-text-muted)]" />
            <input type="search" aria-label="Search tasks" placeholder="Search" value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={`${CONTROL} w-full pl-7 pr-2 placeholder:text-[var(--color-text-muted)]`} />
          </label>
          <button type="button" onClick={() => { create.reset(); setCreating(true) }}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)]">
            <Plus size={12} aria-hidden="true" />
            New task
          </button>
          {/* Over the gap under the row, not in the flow: it moves nothing when it comes or goes (§1). */}
          {moveError && (
            <p role="alert" title={moveError}
              className="absolute inset-x-0 top-full truncate text-[11px] leading-4 text-[var(--color-danger)]">
              {moveError}
            </p>
          )}
        </header>

        {tasks.isPending ? (
          <div className="flex items-center py-12 text-xs text-[var(--color-text-muted)]">
            <Loader2 size={14} className="mr-2 animate-spin" />
            Loading tasks…
          </div>
        ) : empty ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">No tasks yet.</p>
        ) : noMatch ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">No tasks match.</p>
        ) : mode === 'board' ? (
          <TasksBoard tasks={visible} onError={setMoveError} />
        ) : (
          <TasksList tasks={visible} showAssignee={agent === ALL_AGENTS} />
        )}

        {/* Below the content, never above it: the read re-runs every five seconds (§1). */}
        {tasks.isError && (
          <p className="text-[11px] text-[var(--color-text-muted)]" role="alert">
            Tasks could not be read.{' '}
            <button type="button" onClick={() => void tasks.refetch()}
              className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">
              Try again
            </button>
          </p>
        )}
      </div>
      {creating && <NewTaskDialog create={create} onClose={() => setCreating(false)} />}
    </div>
  )
}
