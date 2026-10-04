import { useEffect, useMemo, useRef, useState } from 'react'
import { Columns3, HistoryIcon, List, Loader2, Plus, Search } from 'lucide-react'
import { useTaskList } from '../../hooks/useTaskList'
import { useAgents } from '../../hooks/useAgents'
import { useCreateTask, useFolderBoard, useOpenTask } from '../../hooks/useTasks'
import { useUIStore, type TasksViewMode } from '../../stores/ui.store'
import { TasksList, TasksRecentList } from './TasksList'
import { TasksBoard } from './TasksBoard'
import { NewTaskDialog } from './TaskFormDialog'
import { TasksRunNextControl } from './TasksDispatchControl'
import { useDispatchControls, useTaskDispatchList } from '../../hooks/useTaskDispatch'
import { ALL_AGENTS, UNASSIGNED, agentFilterOptions, matchesTaskFilters, type TaskAgentFilter } from './tasksViewModel'

const MODES: readonly { value: TasksViewMode; label: string; Icon: typeof List }[] = [
  { value: 'list', label: 'List', Icon: List },
  { value: 'recent', label: 'Recent', Icon: HistoryIcon },
  { value: 'board', label: 'Board', Icon: Columns3 }
]

const CONTROL =
  'h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-xs text-[var(--color-text)] ' +
  'focus:border-[var(--color-accent)] focus:outline-none'

/**
 * Every root task, as a list grouped by category, as one list by last change
 * (**Recent**, what the Inbox's Recent tasks used to be) or as a board — the
 * top bar's Tasks button opens it, and like the Inbox it belongs to no tab.
 *
 * Controls first, in one row (`ux_rules.md` §2): the title, List | Recent |
 * Board (remembered), the agent filter, a title search and **New task**, the one
 * primary action. A refused board move says so in one line laid over the gap
 * under the controls — absolutely placed, so neither the controls nor the
 * board move when it comes and goes (§1). Archived tasks are not here: the
 * root query leaves them out.
 *
 * List and board share one width, wide enough for the board's five columns,
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
 * the filter and the queue, never the search, so typing moves nothing (§1). The queue's
 * actions are owned here too, so a result outlives the menu that asked; a
 * refusal shows under the control, in the same overlay slot as a refused
 * move. A started task stays put: its row moves to In progress on its own.
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
  const [search, setSearch] = useState('')
  // Narrower than the row needs, the search is a glyph until asked for. It
  // stays open while it holds text, so typing never collapses it (§1).
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchExpanded = searchOpen || search !== ''
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus({ preventScroll: true })
  }, [searchOpen])
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
  const agentName = (id: string): string | undefined => agents?.find((entry) => entry.id === id)?.name
  const agentOptions = agentFilterOptions(rows, agentName)
  const visible = useMemo(() => rows.filter((task) => matchesTaskFilters(task, agent, search)), [rows, agent, search])
  const boardAgent = mode === 'board' && agent.startsWith('agent:') ? agent.slice('agent:'.length) : null
  const folderBoard = useFolderBoard(boardAgent)
  const boardPending = boardAgent !== null && folderBoard.isPending
  const empty = !tasks.isPending && rows.length === 0 && !tasks.isError
  /** Tasks exist, the filters leave none: one line instead of five empty sections. */
  const noMatch = rows.length > 0 && visible.length === 0

  return (
    <div data-tasks-scroll className="flex-1 overflow-y-auto pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      <div data-sidebar-band-limit className="w-full max-w-7xl mx-auto px-6 py-6 space-y-4">
        {/*
          One row at every width (§2): at the 800 px minimum, beside the
          sidebar, the switch drops its words for its icons (the name stays,
          in aria-label and title), the search folds to its glyph, and the
          agent filter gives up width before anything spills past the row.
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
            The agent filter and the search share what the row has left. The
            filter gives up width first (it truncates). Below @xl (the 800 px
            window beside the sidebar) that leaves too little for a field, so
            the search is its glyph alone; a click or Tab onto it opens the
            field laid over the filter, so nothing in the row moves. Open, it
            stays open while it holds text, and folds again on leaving it empty.
          */}
          <div className={`relative flex min-w-0 flex-1 items-center ${dispatchState ? 'gap-1.5 @xl:gap-2' : 'gap-2'}`}>
            <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)}
              className={`${CONTROL} w-40 min-w-16 shrink truncate px-2`}>
              <option value={ALL_AGENTS}>All agents</option>
              {agentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              {agent !== ALL_AGENTS && agent !== UNASSIGNED && !agentOptions.some((option) => option.value === agent) && (
                <option value={agent}>{agentName(agent.slice('agent:'.length)) ?? 'Agent'}</option>
              )}
              <option value={UNASSIGNED}>No agent</option>
            </select>
            <div className="flex min-w-7 flex-1 basis-0 items-center @xl:min-w-20">
              {!searchExpanded && (
                <button type="button" aria-label="Search" title="Search tasks"
                  onFocus={() => setSearchOpen(true)} onClick={() => setSearchOpen(true)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] @xl:hidden">
                  <Search size={12} aria-hidden="true" />
                </button>
              )}
              <label className={`min-w-20 flex-1 items-center ${searchExpanded
                ? 'absolute inset-0 z-10 flex @xl:relative'
                : 'relative hidden @xl:flex'}`}>
                <Search size={12} aria-hidden="true" className="pointer-events-none absolute left-2 text-[var(--color-text-muted)]" />
                <input ref={searchRef} type="search" aria-label="Search tasks" placeholder="Search" value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onBlur={() => setSearchOpen(false)}
                  className={`${CONTROL} w-full pl-7 pr-2 placeholder:text-[var(--color-text-muted)]`} />
              </label>
            </div>
          </div>
          {dispatchState && (
            <TasksRunNextControl
              // One instance per agent: a held N belongs to the agent it was chosen for.
              key={dispatchState.agentId}
              agentName={agentName(dispatchState.agentId) ?? 'This agent'}
              state={dispatchState}
              controls={{ ...dispatch, runNext: (taskId) => { setMoveError(null); return dispatch.runNext(taskId) } }}
            />
          )}
          <button type="button" onClick={() => { create.reset(); setCreating(true) }}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)]">
            <Plus size={12} aria-hidden="true" />
            New task
          </button>
          {/* Over the gap under the row, not in the flow: it moves nothing when it comes or goes (§1). */}
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

        {tasks.isPending || boardPending ? (
          <div className="flex items-center py-12 text-xs text-[var(--color-text-muted)]">
            <Loader2 size={14} className="mr-2 animate-spin" />
            Loading tasks…
          </div>
        ) : empty ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">No tasks yet.</p>
        ) : noMatch ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">No tasks match.</p>
        ) : mode === 'board' ? (
          <TasksBoard tasks={visible} onError={(message) => { if (message) dispatch.clearError(); setMoveError(message) }} folderColumns={folderBoard.data ?? null} />
        ) : mode === 'recent' ? (
          // Keyed by the filter: its rows hold the order first seen, and
          // another agent's rows were never seen here (`TasksRecentList`).
          <TasksRecentList key={agent} tasks={visible} showAssignee={agent === ALL_AGENTS} />
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
