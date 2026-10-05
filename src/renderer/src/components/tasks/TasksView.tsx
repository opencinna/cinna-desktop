import { useMemo, useState } from 'react'
import { Columns3, HistoryIcon, List, Loader2, Plus, Users } from 'lucide-react'
import { useTaskList } from '../../hooks/useTaskList'
import { useAgents } from '../../hooks/useAgents'
import { useCreateTask, useFolderBoard, useOpenTask } from '../../hooks/useTasks'
import { useUIStore, type TasksViewMode } from '../../stores/ui.store'
import { TasksList, TasksRecentList } from './TasksList'
import { TasksBoard } from './TasksBoard'
import { TasksAgents } from './TasksAgents'
import { TasksFilterButton, type TasksFilterState } from './TasksFilters'
import { NewTaskDialog } from './TaskFormDialog'
import { TasksRunNextControl } from './TasksDispatchControl'
import { useDispatchControls, useTaskDispatchList } from '../../hooks/useTaskDispatch'
import { ALL_AGENTS, agentCards, agentFilterOptions, matchesTaskFilters, taskPeriodLabel, withinTaskPeriod, type TaskAgentFilter } from './tasksViewModel'

const MODES: readonly { value: TasksViewMode; label: string; Icon: typeof List }[] = [
  { value: 'agents', label: 'Agents', Icon: Users },
  { value: 'recent', label: 'Recent', Icon: HistoryIcon },
  { value: 'board', label: 'Board', Icon: Columns3 },
  { value: 'list', label: 'List', Icon: List }
]

/**
 * Every root task, as the team (**Agents**, the default: a card per agent with
 * its tasks inside), as one list by last change (**Recent**, what the Inbox's
 * Recent tasks used to be), as a board, or as a list grouped by category — the
 * top bar's Tasks button opens it, and like the Inbox it belongs to no tab.
 *
 * Controls first, in one row (`ux_rules.md` §2): the title, Agents | Recent |
 * Board | List (remembered), the queue's Run next when filtered to one, the
 * filters block and **New task**, the one primary action. The search, the
 * agent and the period live in the Filters form; what they apply shows as
 * pills inside the block, beside its Filters button (`TasksFilterButton`) —
 * Last week to begin with. A refused board move says so in one
 * line laid over the gap under the controls — absolutely placed, so neither
 * the controls nor the board move when it comes and goes (§1). Archived tasks
 * are not here: the root query leaves them out.
 *
 * The period reaches only work nobody holds open (`withinTaskPeriod`):
 * Waiting, In progress and Ready show whenever they last changed.
 *
 * Every layout shares one width, wide enough for the board's five columns,
 * so switching between them moves none of the controls.
 *
 * Filtered to one agent, the board asks for that agent's folder board; a bare
 * agent whose tasks live in `.cinna/tasks/` gets its own words as columns
 * (`TasksBoard`), every other agent the five categories. Until that answer is
 * in, the board waits on the loading line rather than drawing five columns it
 * would then replace (§1). A failed read falls back to the categories.
 *
 * The New task mutation is owned here, not by the dialog, so the hook-level
 * `onCreated` that closes the dialog and opens the task runs even though the
 * dialog unmounts on the way (§5).
 *
 * Filtered to one agent whose queue Cinna works (a folder agent), the row
 * gains that queue's **Run next** with the run mode behind its chevron; a
 * paused queue turns it into **Resume** in place, adding no row. It follows
 * the agent filter and the queue, never the search, so typing moves nothing
 * (§1). The queue's actions are owned here too, so a result outlives the menu
 * that asked; a refusal shows right-aligned under the row, in the same
 * overlay slot as a refused move. A started task stays put: its row moves to In progress on
 * its own.
 */
export function TasksView(): React.JSX.Element {
  const mode = useUIStore((s) => s.tasksViewMode)
  const setMode = useUIStore((s) => s.setTasksViewMode)
  const tasks = useTaskList({ rootOnly: true })
  const { data: agents } = useAgents()
  const openTask = useOpenTask()
  // In the store, not local state: Back to Tasks remounts this view, and a
  // folder board the user filtered to should still be there.
  const agent: TaskAgentFilter = useUIStore((s) => s.tasksAgentFilter)
  const setAgent = useUIStore((s) => s.setTasksAgentFilter)
  const period = useUIStore((s) => s.tasksPeriod)
  const setPeriod = useUIStore((s) => s.setTasksPeriod)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const dispatchList = useTaskDispatchList()
  const filteredAgentId = agent.startsWith('agent:') ? agent.slice('agent:'.length) : null
  const dispatchState = filteredAgentId ? dispatchList.data?.find((entry) => entry.agentId === filteredAgentId) ?? null : null
  const dispatch = useDispatchControls(dispatchState ? dispatchState.agentId : null)
  /** A refused Run next, Resume or mode change. */
  const dispatchError = dispatch.error ? dispatch.error.message : null
  const create = useCreateTask({
    onCreated: (task) => {
      setCreating(false)
      openTask(task.id)
    }
  })

  const rows = useMemo(() => tasks.data?.tasks ?? [], [tasks.data])
  // Read once per list: the period is days wide, and a boundary crossed while
  // the view is open waits for the next poll rather than a timer of its own.
  const inPeriod = useMemo(() => {
    const now = Date.now()
    return rows.filter((task) => withinTaskPeriod(task, period, now))
  }, [rows, period])
  const agentName = (id: string): string | undefined => agents?.find((entry) => entry.id === id)?.name
  const visible = useMemo(() => inPeriod.filter((task) => matchesTaskFilters(task, agent, search)), [inPeriod, agent, search])
  const searching = search.trim() !== ''
  const agentOptions = agentFilterOptions(rows, agentName)
  const cards = useMemo(
    () => mode === 'agents' ? agentCards(visible, agentName) : [],
    // agentName reads `agents`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, visible, agents]
  )
  const boardAgent = mode === 'board' && agent.startsWith('agent:') ? agent.slice('agent:'.length) : null
  const folderBoard = useFolderBoard(boardAgent)
  const boardPending = boardAgent !== null && folderBoard.isPending
  const empty = !tasks.isPending && rows.length === 0 && !tasks.isError
  /**
   * The filters leave nothing: one line instead of five empty sections — "No
   * tasks match." for a search, or an agent with no task at all, the period's
   * own words when it was the period that emptied the view.
   */
  const noMatch = rows.length > 0 && visible.length === 0
  /** The first read failed: nothing is known, so no layout may claim there are no tasks. */
  const unread = tasks.isError && !tasks.data
  const clearErrors = (): void => { setMoveError(null); dispatch.clearError() }
  // A refusal belongs to the filter it was made under: changing the agent or
  // the period clears it, so a stale sentence never outlives its board.
  const filters: TasksFilterState = {
    agent, setAgent: (next) => { clearErrors(); setAgent(next) },
    search, setSearch,
    period, setPeriod: (next) => { clearErrors(); setPeriod(next) },
    agentOptions, agentName
  }
  const periodText = period === 'all' ? 'No tasks' : `No tasks in the ${taskPeriodLabel(period).toLowerCase()}`
  /**
   * A filter change takes the first-seen order again: those rows were never
   * seen here (`useTaskRowsInPlace`). Starting or clearing a search does too —
   * rows first seen through a search would otherwise keep their places above
   * a card's Waiting rows once it is cleared — but not each keystroke.
   */
  const seenKey = `${agent}:${period}:${searching}`

  return (
    <div data-tasks-scroll className="flex-1 overflow-y-auto pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      <div data-sidebar-band-limit className="w-full max-w-7xl mx-auto px-6 py-6 space-y-4">
        <div>
          {/*
            One row at every width (§2): at the 800 px minimum, beside the
            sidebar, the switch drops its words for its icons (the name stays,
            in aria-label and title), Filters and New task keep only their
            glyphs, and the filter pills truncate to a few letters each.
          */}
          <header className={`@container relative flex min-w-0 items-center ${dispatchState ? 'gap-1.5 @xl:gap-2' : 'gap-2'}`}>
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
            {/*
              Left of the gap, not beside Filters: the filters block grows
              leftwards as pills come, and must not push the queue control
              about while a search is typed.
            */}
            {dispatchState && (
              <TasksRunNextControl
                // One instance per agent: a held N belongs to the agent it was chosen for.
                key={dispatchState.agentId}
                agentName={agentName(dispatchState.agentId) ?? 'This agent'}
                state={dispatchState}
                controls={{ ...dispatch, runNext: (taskId) => { setMoveError(null); return dispatch.runNext(taskId) } }}
              />
            )}
            <div className="min-w-0 flex-1" />
            <TasksFilterButton filters={filters} />
            {/* Below @xl its word gives way to the filter pills; the name stays in aria-label and title. */}
            <button type="button" aria-label="New task" title="New task" onClick={() => { create.reset(); setCreating(true) }}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] @xl:px-3">
              <Plus size={12} aria-hidden="true" />
              <span className="hidden @xl:inline">New task</span>
            </button>
            {/* Over the gap under the row, not in the flow: they move nothing when they come or go (§1). */}
            {dispatchError && !moveError && (
              <p role="alert" title={dispatchError}
                className="absolute right-0 top-full max-w-full truncate text-right text-[11px] leading-4 text-[var(--color-danger)]">
                {dispatchError}
              </p>
            )}
            {moveError && (
              <p role="alert" title={moveError}
                className="absolute inset-x-0 top-full truncate text-[11px] leading-4 text-[var(--color-danger)]">
                {moveError}
              </p>
            )}
          </header>
        </div>

        {tasks.isPending || boardPending ? (
          <div className="flex items-center py-12 text-xs text-[var(--color-text-muted)]">
            <Loader2 size={14} className="mr-2 animate-spin" />
            Loading tasks…
          </div>
        ) : unread ? null : noMatch ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">{searching || !rows.some((task) => matchesTaskFilters(task, agent, '')) ? 'No tasks match.' : `${periodText}.`}</p>
        ) : empty ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">No tasks yet.</p>
        ) : mode === 'agents' ? (
          <TasksAgents key={seenKey} cards={cards} agents={agents} />
        ) : mode === 'board' ? (
          <TasksBoard tasks={visible} onError={(message) => { if (message) dispatch.clearError(); setMoveError(message) }} folderColumns={folderBoard.data ?? null} />
        ) : mode === 'recent' ? (
          // Keyed by the filters: its rows hold the order first seen, and
          // another agent's or another period's rows were never seen here.
          <TasksRecentList key={seenKey} tasks={visible} showAssignee={agent === ALL_AGENTS} />
        ) : (
          // Keyed like Recent: every section holds the order first seen.
          <TasksList key={seenKey} tasks={visible} showAssignee={agent === ALL_AGENTS} />
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
