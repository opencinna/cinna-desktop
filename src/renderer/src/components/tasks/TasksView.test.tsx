import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDto } from '../../../../shared/tasks'
import type { TaskBoardColumn } from '../../../../shared/folderTasks'
import type { AgentDispatchState, TaskDispatchMode, TaskDispatchRunResult, TaskDispatchUpdateResult } from '../../../../shared/taskDispatch'

/**
 * The Tasks view: the list grouped by category, the agent filter and search,
 * the board's drops through `task:set-status` (and what happens when main
 * refuses one), and New task closing only on success.
 */

const AGENTS = [
  { id: 'agent-w', name: 'Writer', enabled: true, source: 'folder' },
  { id: 'agent-r', name: 'Reviewer', enabled: true, source: 'folder' },
  { id: 'agent-off', name: 'Sleeper', enabled: false, source: 'folder' }
]
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: AGENTS, isPending: false }) }))

;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => undefined } }

const listTasks = vi.fn<() => Promise<TaskDto[]>>()
const setStatus = vi.fn<(id: string, status: string, label?: string | null) => Promise<TaskDto>>()
const folderBoard = vi.fn<(agentId: string) => Promise<TaskBoardColumn[] | null>>()
const createTask = vi.fn<(input: unknown) => Promise<TaskDto>>()
const dispatchList = vi.fn<() => Promise<AgentDispatchState[]>>()
const runNext = vi.fn<(agentId: string, taskId?: string) => Promise<TaskDispatchRunResult>>()
const setMode = vi.fn<(agentId: string, mode: TaskDispatchMode) => Promise<TaskDispatchUpdateResult>>()
const resume = vi.fn<(agentId: string) => Promise<TaskDispatchUpdateResult>>()
/** The pushed `taskDispatch:changed`, captured so a test can fire it. */
let dispatchChanged: (() => void) | null = null

const { TasksView } = await import('./TasksView')
const { useUIStore } = await import('../../stores/ui.store')

function task(id: string, overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id, title: `Task ${id}`, goal: 'g', description: null, status: 'new', priority: 'normal', router: 'direct',
    origin: 'local', executor: 'desktop', executorDevice: null, runsHere: true, chatId: null,
    assignee: { kind: 'model', agentId: null, name: null }, parentTaskId: null, subtaskCount: 0,
    subtaskCompletedCount: 0, remote: null, handoffNote: null, artifacts: [], budget: null, errorMessage: null,
    customFields: null, statusLabel: null, file: null, fromOutside: false, blockedBy: [], dispatchNote: null, jobId: null, jobRunId: null, createdAt: new Date('2026-10-01T09:00:00Z'),
    updatedAt: new Date('2026-10-01T09:00:00Z'), startedAt: null, finishedAt: null, ...overrides
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const writer = { kind: 'agent' as const, agentId: 'agent-w', name: 'Writer' }
const reviewer = { kind: 'agent' as const, agentId: 'agent-r', name: 'Reviewer' }

const TASKS: TaskDto[] = [
  task('b1', { title: 'Plan the launch', status: 'new', assignee: writer }),
  task('b2', { title: 'Refine pricing', status: 'refining' }),
  task('r1', { title: 'Write the changelog', status: 'open', assignee: writer, priority: 'urgent' }),
  task('a1', { title: 'Review copy', status: 'in_progress', assignee: reviewer }),
  task('w1', { title: 'Answer legal', status: 'blocked' }),
  task('d1', { title: 'Old launch', status: 'completed', assignee: writer }),
  task('d2', { title: 'Failed export', status: 'error' })
]

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  listTasks.mockReset().mockResolvedValue(TASKS)
  setStatus.mockReset()
  folderBoard.mockReset().mockResolvedValue(null)
  createTask.mockReset()
  dispatchList.mockReset().mockResolvedValue([])
  runNext.mockReset()
  setMode.mockReset()
  resume.mockReset()
  dispatchChanged = null
  useUIStore.setState({ activeView: 'tasks', tasksViewMode: 'list', tasksAgentFilter: 'all', activeTaskId: null, taskOpenedFromTasks: false })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    tasks: {
      list: () => listTasks(),
      setStatus: (...args: [string, string, (string | null)?]) => setStatus(...args),
      folderBoard: (agentId: string) => folderBoard(agentId),
      create: (input: unknown) => createTask(input)
    },
    inbox: { list: async () => ({ entries: [], unreadable: [] }) },
    taskDispatch: {
      list: () => dispatchList(),
      runNext: (agentId: string, taskId?: string) => runNext(agentId, taskId),
      setMode: (agentId: string, mode: TaskDispatchMode) => setMode(agentId, mode),
      resume: (agentId: string) => resume(agentId),
      onChanged: (handler: () => void) => { dispatchChanged = handler; return () => {} }
    }
  }
})
afterEach(cleanup)

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}
function titlesIn(element: HTMLElement): string[] {
  return within(element).queryAllByRole('button', { name: / — / }).map((button) => button.getAttribute('aria-label')!.split(' — ')[0])
}

describe('list', () => {
  it('groups root tasks into the five sections, in the order the user acts on them', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    const names = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))
    expect(names).toEqual(['Waiting', 'In progress', 'Ready', 'Backlog', 'Done'])
    expect(titlesIn(section('Waiting'))).toEqual(['Answer legal'])
    expect(titlesIn(section('In progress'))).toEqual(['Review copy'])
    expect(titlesIn(section('Ready'))).toEqual(['Write the changelog'])
    expect(titlesIn(section('Backlog'))).toEqual(['Plan the launch', 'Refine pricing'])
    expect(titlesIn(section('Done'))).toEqual(['Old launch', 'Failed export'])
  })

  it('keeps the agent filter when the view is left and opened again (Back to Tasks)', async () => {
    const first = render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'agent:agent-w' } })
    first.unmount()
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('combobox', { name: 'Agent' })
    expect((screen.getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement).value).toBe('agent:agent-w')
  })

  it('filters by agent and by title, keeping every section header at 0', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    const agent = screen.getByRole('combobox', { name: 'Agent' })
    expect(within(agent).getAllByRole('option').map((o) => o.textContent)).toEqual(['All agents', 'Reviewer', 'Writer', 'No agent'])

    fireEvent.change(agent, { target: { value: 'agent:agent-w' } })
    expect(titlesIn(section('Backlog'))).toEqual(['Plan the launch'])
    expect(titlesIn(section('Ready'))).toEqual(['Write the changelog'])
    expect(titlesIn(section('Waiting'))).toEqual([])
    expect(within(section('Waiting')).getByRole('heading').textContent).toBe('Waiting0')

    fireEvent.change(agent, { target: { value: 'none' } })
    expect(titlesIn(section('Backlog'))).toEqual(['Refine pricing'])
    expect(titlesIn(section('Waiting'))).toEqual(['Answer legal'])

    fireEvent.change(agent, { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks' }), { target: { value: 'LAUNCH' } })
    expect(titlesIn(section('Backlog'))).toEqual(['Plan the launch'])
    expect(titlesIn(section('Done'))).toEqual(['Old launch'])
    expect(titlesIn(section('Ready'))).toEqual([])
  })

  it('opens a task with the way back to Tasks remembered', async () => {
    render(createElement(TasksView), { wrapper })
    fireEvent.click(await screen.findByRole('button', { name: /^Plan the launch/ }))
    expect(useUIStore.getState()).toMatchObject({ activeView: 'task', activeTaskId: 'b1', taskOpenedFromTasks: true })
  })

  it('names each row’s agent only while the filter shows every agent', async () => {
    render(createElement(TasksView), { wrapper })
    const row = await screen.findByRole('button', { name: /^Write the changelog/ })
    expect(within(row).getByText('Writer')).toBeTruthy()
    // Unassigned rows carry no chip.
    expect(within(screen.getByRole('button', { name: /^Answer legal/ })).queryByText(/Writer|Reviewer|Unassigned/)).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'agent:agent-w' } })
    expect(within(screen.getByRole('button', { name: /^Write the changelog/ })).queryByText('Writer')).toBeNull()
  })

  it('says “No tasks match.” in place of the sections when the search finds nothing', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No tasks match.')).toBeTruthy()
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByRole('button', { name: 'New task' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Board' }))
    expect(screen.getByText('No tasks match.')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks' }), { target: { value: '' } })
    expect(screen.queryByText('No tasks match.')).toBeNull()
    expect(screen.getAllByRole('region')).toHaveLength(5)
  })

  it('remembers List | Board', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.click(screen.getByRole('button', { name: 'Board' }))
    expect(useUIStore.getState().tasksViewMode).toBe('board')
    expect(localStorage.getItem('cinna-tasks-view-mode')).toBe('board')
  })
})

describe('board', () => {
  function dataTransfer(): DataTransfer {
    const data = new Map<string, string>()
    return {
      dropEffect: 'none', effectAllowed: 'all', types: [],
      setData: (type: string, value: string) => { data.set(type, value) },
      getData: (type: string) => data.get(type) ?? ''
    } as unknown as DataTransfer
  }
  function card(id: string): HTMLElement {
    return document.querySelector(`[data-task-card="${id}"]`) as HTMLElement
  }
  function column(name: string): HTMLElement {
    return screen.getByRole('region', { name })
  }

  beforeEach(() => { useUIStore.setState({ tasksViewMode: 'board' }) })

  it('drops a card on a user column through task:set-status with that column’s status', async () => {
    setStatus.mockImplementation(async (id, status) => ({ ...TASKS.find((t) => t.id === id)!, status: status as TaskDto['status'] }))
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Backlog', 'Ready', 'In progress', 'Waiting', 'Done'])

    const transfer = dataTransfer()
    fireEvent.dragStart(card('b1'), { dataTransfer: transfer })
    fireEvent.dragOver(column('Ready'), { dataTransfer: transfer })
    expect(transfer.dropEffect).toBe('move')
    fireEvent.drop(column('Ready'), { dataTransfer: transfer })
    // Moved at once, before main answers.
    expect(titlesIn(column('Ready'))).toEqual(['Write the changelog', 'Plan the launch'])
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('b1', 'open'))

    const again = dataTransfer()
    fireEvent.dragStart(card('r1'), { dataTransfer: again })
    fireEvent.drop(column('Done'), { dataTransfer: again })
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('r1', 'completed'))
    // Main accepted (the manual overlay allows Ready → Done): it stays in Done, no error.
    await waitFor(() => expect(titlesIn(column('Done'))).toContain('Write the changelog'))
    expect(titlesIn(column('Ready'))).not.toContain('Write the changelog')
    expect(screen.queryByRole('alert')).toBeNull()
    // Done is final on the board: no drag, no ⋯.
    expect(card('r1').getAttribute('draggable')).toBe('false')
    expect(within(card('r1')).queryByRole('button', { name: /^Actions for/ })).toBeNull()
  })

  it('moves the card back and shows main’s refusal under the controls', async () => {
    setStatus.mockRejectedValue(new Error("Error invoking remote method 'task:set-status': Error: A task cannot go from open to new"))
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Write the changelog/ })
    expect(screen.queryByRole('alert')).toBeNull()
    const transfer = dataTransfer()
    fireEvent.dragStart(card('r1'), { dataTransfer: transfer })
    fireEvent.drop(column('Backlog'), { dataTransfer: transfer })
    expect(titlesIn(column('Backlog'))).toContain('Write the changelog')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('A task cannot go from open to new')
    expect(titlesIn(column('Backlog'))).not.toContain('Write the changelog')
    expect(titlesIn(column('Ready'))).toEqual(['Write the changelog'])
    // Laid over the gap under the controls row, out of the flow: the board does not move (§1).
    expect(screen.getByRole('button', { name: 'New task' }).compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alert.closest('header')).not.toBeNull()
    expect(alert.className).toMatch(/\babsolute\b/)
  })

  it('offers a card only the columns it can reach: Failed goes back to Backlog, Done goes nowhere', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Failed export/ })
    // Done: not draggable, no ⋯.
    expect(card('d1').getAttribute('draggable')).toBe('false')
    expect(within(card('d1')).queryByRole('button', { name: /^Actions for/ })).toBeNull()
    // Failed: Backlog only (error → new), never Ready.
    expect(card('d2').getAttribute('draggable')).toBe('true')
    const transfer = dataTransfer()
    fireEvent.dragStart(card('d2'), { dataTransfer: transfer })
    expect(fireEvent.dragOver(column('Ready'), { dataTransfer: transfer })).toBe(true)
    expect(transfer.dropEffect).toBe('none')
    fireEvent.drop(column('Ready'), { dataTransfer: transfer })
    expect(setStatus).not.toHaveBeenCalled()
    expect(fireEvent.dragOver(column('Backlog'), { dataTransfer: transfer })).toBe(false)
    expect(transfer.dropEffect).toBe('move')
    fireEvent.dragEnd(card('d2'), { dataTransfer: transfer })
    fireEvent.click(within(card('d2')).getByRole('button', { name: 'Actions for Failed export' }))
    const menu = await screen.findByRole('menu', { name: 'Task actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Move to Backlog'])
  })

  it('a bound Ready card has nowhere to go by hand', async () => {
    listTasks.mockResolvedValue([task('k1', { title: 'Bound', status: 'open',
      remote: { adapter: 'cinna', id: 'r', key: 'K-1' } as unknown as TaskDto['remote'] })])
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Bound/ })
    expect(card('k1').getAttribute('draggable')).toBe('false')
  })

  it('a refused earlier move does not undo a later move of the same card', async () => {
    const first = deferred<TaskDto>()
    const second = deferred<TaskDto>()
    setStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    const one = dataTransfer()
    fireEvent.dragStart(card('b1'), { dataTransfer: one })
    fireEvent.drop(column('Ready'), { dataTransfer: one })
    const two = dataTransfer()
    fireEvent.dragStart(card('b1'), { dataTransfer: two })
    fireEvent.drop(column('Done'), { dataTransfer: two })
    expect(titlesIn(column('Done'))).toContain('Plan the launch')
    await act(async () => { first.reject(new Error("Error invoking remote method 'task:set-status': Error: Not now")) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Not now')
    // The refusal took back only its own override: the card stays where the later move put it.
    expect(titlesIn(column('Done'))).toContain('Plan the launch')
    expect(titlesIn(column('Backlog'))).not.toContain('Plan the launch')
    await act(async () => { second.resolve({ ...TASKS[0], status: 'completed' }) })
  })

  it('lets a newer status from a read replace a move it has not confirmed', async () => {
    setStatus.mockImplementation(async (id, status) => ({ ...TASKS.find((t) => t.id === id)!, status: status as TaskDto['status'] }))
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    listTasks.mockResolvedValue(TASKS.map((t) => (t.id === 'b1' ? { ...t, status: 'in_progress' as const } : t)))
    const transfer = dataTransfer()
    fireEvent.dragStart(card('b1'), { dataTransfer: transfer })
    fireEvent.drop(column('Ready'), { dataTransfer: transfer })
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('b1', 'open'))
    await act(async () => { await client.invalidateQueries() })
    // A run started it before any read showed Ready: the override must not hold it in Ready.
    await waitFor(() => expect(titlesIn(column('In progress'))).toContain('Plan the launch'))
    expect(titlesIn(column('Ready'))).not.toContain('Plan the launch')
  })

  it('never accepts a drop on In progress or Waiting', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    for (const name of ['In progress', 'Waiting']) {
      const transfer = dataTransfer()
      fireEvent.dragStart(card('b1'), { dataTransfer: transfer })
      const over = fireEvent.dragOver(column(name), { dataTransfer: transfer })
      expect(over).toBe(true) // not prevented: the browser shows not-allowed
      expect(transfer.dropEffect).toBe('none')
      fireEvent.drop(column(name), { dataTransfer: transfer })
      fireEvent.dragEnd(card('b1'), { dataTransfer: transfer })
    }
    expect(setStatus).not.toHaveBeenCalled()
    expect(titlesIn(column('Backlog'))).toContain('Plan the launch')
  })

  it('lets only desktop-held, runtime-free cards in user columns be dragged or moved', async () => {
    listTasks.mockResolvedValue([
      ...TASKS,
      task('x1', { title: 'Elsewhere', runsHere: false }),
      task('x2', { title: 'On a service', executor: 'remote', runsHere: false }),
      task('x3', { title: 'Runtime', runtime: { state: 'running' } as TaskDto['runtime'] })
    ])
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    expect(card('b1').getAttribute('draggable')).toBe('true')
    for (const id of ['x1', 'x2', 'x3', 'a1', 'w1']) {
      expect(card(id).getAttribute('draggable')).toBe('false')
      expect(within(card(id)).queryByRole('button', { name: /^Actions for/ })).toBeNull()
    }
  })

  it('offers the same moves from the card’s ⋯ menu, without the current column', async () => {
    setStatus.mockImplementation(async (id, status) => ({ ...TASKS.find((t) => t.id === id)!, status: status as TaskDto['status'] }))
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.click(within(card('b1')).getByRole('button', { name: 'Actions for Plan the launch' }))
    const menu = await screen.findByRole('menu', { name: 'Task actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Move to Ready', 'Move to Done'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to Done' }))
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('b1', 'completed'))
  })

  it('shows the assignee and only a high or urgent priority', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    expect(within(card('r1')).getByText('Writer')).toBeTruthy()
    expect(within(card('r1')).getByLabelText('Urgent')).toBeTruthy()
    expect(within(card('b2')).queryByLabelText(/priority|Urgent/)).toBeNull()
  })
})

describe('status words', () => {
  const FOLDER_TASK = task('f1', {
    title: 'Fix login', status: 'open', statusLabel: 'up next', assignee: writer,
    remote: { adapter: 'folder', id: 'agent-w:t-1', key: 't-1', url: null } as unknown as TaskDto['remote'],
    file: { path: '/w/.cinna/tasks/fix-login.md', readOnlyFields: [], blockedBy: [] }
  })

  it('names a row by the folder’s word, while it is grouped by its category', async () => {
    listTasks.mockResolvedValue([...TASKS, FOLDER_TASK])
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: 'Fix login — up next' })
    expect(titlesIn(section('Ready'))).toEqual(['Write the changelog', 'Fix login'])
    // A task without a word keeps the category word.
    expect(screen.getByRole('button', { name: 'Write the changelog — Ready' })).toBeTruthy()
  })

  it('names a card by the folder’s word on the category board, and moves it as an unbound task', async () => {
    useUIStore.setState({ tasksViewMode: 'board' })
    listTasks.mockResolvedValue([FOLDER_TASK])
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: 'Fix login — up next' })
    expect(document.querySelector('[data-tasks-board]')?.getAttribute('data-tasks-board')).toBe('categories')
    // Bound to the folder adapter, but a file keeps no table: Ready → Backlog and Done are open to it.
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Fix login' }))
    const menu = await screen.findByRole('menu', { name: 'Task actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Move to Backlog', 'Move to Done'])
  })
})

describe('folder board', () => {
  const COLUMNS: TaskBoardColumn[] = [
    { label: 'Todo', category: 'backlog', status: 'new', droppable: true },
    { label: 'Up Next', category: 'ready', status: 'open', droppable: true },
    { label: 'Doing', category: 'active', status: 'in_progress', droppable: false },
    { label: 'Shipped', category: 'done', status: 'completed', droppable: true },
    { label: 'Someday', category: null, status: 'new', droppable: false }
  ]
  const folderBinding = (id: string): Partial<TaskDto> => ({
    assignee: writer,
    remote: { adapter: 'folder', id: `agent-w:${id}`, key: id, url: null } as unknown as TaskDto['remote'],
    file: { path: `/w/.cinna/tasks/${id}.md`, readOnlyFields: [], blockedBy: [] }
  })
  const FOLDER_TASKS: TaskDto[] = [
    task('f1', { title: 'Fix login', status: 'new', statusLabel: 'todo', ...folderBinding('f1') }),
    task('f2', { title: 'Ship docs', status: 'open', statusLabel: 'up-next', ...folderBinding('f2') }),
    task('f3', { title: 'Dream big', status: 'new', statusLabel: 'Someday', ...folderBinding('f3') }),
    // Its word has no column and its category none either: the first column.
    task('f4', { title: 'Wait on legal', status: 'blocked', statusLabel: 'review', ...folderBinding('f4') })
  ]

  function dataTransfer(): DataTransfer {
    const data = new Map<string, string>()
    return {
      dropEffect: 'none', effectAllowed: 'all', types: [],
      setData: (type: string, value: string) => { data.set(type, value) },
      getData: (type: string) => data.get(type) ?? ''
    } as unknown as DataTransfer
  }
  function card(id: string): HTMLElement {
    return document.querySelector(`[data-task-card="${id}"]`) as HTMLElement
  }
  function column(name: string): HTMLElement {
    return screen.getByRole('region', { name })
  }
  async function renderFiltered(): Promise<void> {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'agent:agent-w' } })
    await screen.findByRole('region', { name: 'Todo' })
  }

  beforeEach(() => {
    useUIStore.setState({ tasksViewMode: 'board' })
    listTasks.mockResolvedValue([...TASKS, ...FOLDER_TASKS])
    folderBoard.mockImplementation(async (agentId) => (agentId === 'agent-w' ? COLUMNS : null))
  })

  it('uses the folder’s words as columns, in order, placing each card by its word, else by its category', async () => {
    await renderFiltered()
    expect(folderBoard).toHaveBeenCalledWith('agent-w')
    expect(document.querySelector('[data-tasks-board]')?.getAttribute('data-tasks-board')).toBe('folder')
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Todo', 'Up Next', 'Doing', 'Shipped', 'Someday'])
    // Native tasks of the agent land in their category's first column.
    expect(titlesIn(column('Todo'))).toEqual(['Plan the launch', 'Fix login', 'Wait on legal'])
    expect(titlesIn(column('Up Next'))).toEqual(['Write the changelog', 'Ship docs'])
    expect(titlesIn(column('Doing'))).toEqual([])
    expect(titlesIn(column('Shipped'))).toEqual(['Old launch'])
    expect(titlesIn(column('Someday'))).toEqual(['Dream big'])
    // The words as written: no small capitals on a folder column's title.
    expect(within(column('Up Next')).getByRole('heading').className).not.toMatch(/uppercase/)
    expect(column('Doing').getAttribute('data-droppable')).toBe('false')
    expect(column('Todo').getAttribute('data-folder-column')).toBe('Todo')
    expect(screen.getByRole('button', { name: 'Ship docs — up-next' })).toBeTruthy()
  })

  it('keeps the five categories for an agent without a folder board, and for All agents', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    expect(folderBoard).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'agent:agent-r' } })
    await waitFor(() => expect(folderBoard).toHaveBeenCalledWith('agent-r'))
    await screen.findByRole('region', { name: 'In progress' })
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Backlog', 'Ready', 'In progress', 'Waiting', 'Done'])
  })

  it('waits on the loading line, not on five columns it would replace', async () => {
    let answer!: (columns: TaskBoardColumn[]) => void
    folderBoard.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'agent:agent-w' } })
    expect(screen.getByText('Loading tasks…')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Backlog' })).toBeNull()
    await act(async () => { answer(COLUMNS) })
    expect(await screen.findByRole('region', { name: 'Todo' })).toBeTruthy()
  })

  it('drops on a droppable column with its status and its word, moving the card at once', async () => {
    setStatus.mockImplementation(async (id, status, label) =>
      ({ ...FOLDER_TASKS.find((t) => t.id === id)!, status: status as TaskDto['status'], statusLabel: label ?? null }))
    await renderFiltered()
    const transfer = dataTransfer()
    fireEvent.dragStart(card('f1'), { dataTransfer: transfer })
    expect(fireEvent.dragOver(column('Up Next'), { dataTransfer: transfer })).toBe(false)
    expect(transfer.dropEffect).toBe('move')
    fireEvent.drop(column('Up Next'), { dataTransfer: transfer })
    expect(titlesIn(column('Up Next'))).toContain('Fix login')
    expect(screen.getByRole('button', { name: 'Fix login — Up Next' })).toBeTruthy()
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('f1', 'open', 'Up Next'))
    // A native task of the agent has no file for a word: it sends the status alone.
    const again = dataTransfer()
    fireEvent.dragStart(card('b1'), { dataTransfer: again })
    fireEvent.drop(column('Shipped'), { dataTransfer: again })
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('b1', 'completed'))
    expect(setStatus.mock.calls.find((call) => call[0] === 'b1')).toHaveLength(2)
  })

  it('offers a task with no file one column per status it may reach, the first of that status', async () => {
    folderBoard.mockResolvedValue([
      { label: 'Todo', category: 'backlog', status: 'new', droppable: true },
      { label: 'Up Next', category: 'ready', status: 'open', droppable: true },
      { label: 'Next', category: 'ready', status: 'open', droppable: true },
      { label: 'Doing', category: 'active', status: 'in_progress', droppable: false },
      { label: 'Shipped', category: 'done', status: 'completed', droppable: true },
      { label: 'Closed', category: 'done', status: 'completed', droppable: true }
    ])
    await renderFiltered()
    fireEvent.click(within(card('b1')).getByRole('button', { name: 'Actions for Plan the launch' }))
    const menu = await screen.findByRole('menu', { name: 'Task actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Move to Up Next', 'Move to Shipped'])
    fireEvent.keyDown(document, { key: 'Escape' })
    const transfer = dataTransfer()
    fireEvent.dragStart(card('b1'), { dataTransfer: transfer })
    // The second column of a status is not a target.
    expect(fireEvent.dragOver(column('Next'), { dataTransfer: transfer })).toBe(true)
    expect(transfer.dropEffect).toBe('none')
    fireEvent.dragEnd(card('b1'), { dataTransfer: transfer })
  })

  it('places a task with no file by its status, never by a word it carries', async () => {
    listTasks.mockResolvedValue([...TASKS, task('h1', { title: 'Handed over', status: 'open', statusLabel: 'Todo', assignee: writer })])
    await renderFiltered()
    expect(titlesIn(column('Up Next'))).toContain('Handed over')
    expect(titlesIn(column('Todo'))).not.toContain('Handed over')
  })

  it('lets a file task with an unmapped word move to a proper word of its own status', async () => {
    setStatus.mockImplementation(async (id, status, label) =>
      ({ ...FOLDER_TASKS.find((t) => t.id === id)!, status: status as TaskDto['status'], statusLabel: label ?? null }))
    await renderFiltered()
    fireEvent.click(within(card('f3')).getByRole('button', { name: 'Actions for Dream big' }))
    const menu = await screen.findByRole('menu', { name: 'Task actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Move to Todo', 'Move to Up Next', 'Move to Shipped'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to Todo' }))
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('f3', 'new', 'Todo'))
    expect(titlesIn(column('Todo'))).toContain('Dream big')
    // A file task whose own word has a droppable column is not offered its own status again.
    fireEvent.click(within(card('f1')).getByRole('button', { name: 'Actions for Fix login' }))
    const second = await screen.findByRole('menu', { name: 'Task actions' })
    expect(within(second).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Move to Up Next', 'Move to Shipped'])
  })

  it('never accepts a drop on a column that is not droppable, or on the card’s own status', async () => {
    await renderFiltered()
    for (const name of ['Doing', 'Someday', 'Todo']) {
      const transfer = dataTransfer()
      fireEvent.dragStart(card('f2'), { dataTransfer: transfer })
      if (name === 'Todo') {
        // Ready → Backlog is a move a person may make, so Todo takes it.
        expect(fireEvent.dragOver(column(name), { dataTransfer: transfer })).toBe(false)
        fireEvent.dragEnd(card('f2'), { dataTransfer: transfer })
        continue
      }
      expect(fireEvent.dragOver(column(name), { dataTransfer: transfer })).toBe(true)
      expect(transfer.dropEffect).toBe('none')
      fireEvent.drop(column(name), { dataTransfer: transfer })
      fireEvent.dragEnd(card('f2'), { dataTransfer: transfer })
    }
    expect(setStatus).not.toHaveBeenCalled()
    // The card's ⋯ lists only the droppable columns it can reach.
    fireEvent.click(within(card('f1')).getByRole('button', { name: 'Actions for Fix login' }))
    const menu = await screen.findByRole('menu', { name: 'Task actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Move to Up Next', 'Move to Shipped'])
    // A Waiting card stays where a question put it, whichever column its word fell into.
    expect(card('f4').getAttribute('draggable')).toBe('false')
  })

  it('moves the card back and shows main’s refusal', async () => {
    setStatus.mockRejectedValue(new Error("Error invoking remote method 'task:set-status': Error: “Up Next” is not a open word in this folder."))
    await renderFiltered()
    const transfer = dataTransfer()
    fireEvent.dragStart(card('f1'), { dataTransfer: transfer })
    fireEvent.drop(column('Up Next'), { dataTransfer: transfer })
    expect(titlesIn(column('Up Next'))).toContain('Fix login')
    expect((await screen.findByRole('alert')).textContent).toBe('“Up Next” is not a open word in this folder.')
    expect(titlesIn(column('Up Next'))).not.toContain('Fix login')
    expect(titlesIn(column('Todo'))).toContain('Fix login')
  })

  it('holds the columns while a card is dragged, and takes a new word once the drag ends', async () => {
    await renderFiltered()
    const transfer = dataTransfer()
    fireEvent.dragStart(card('f1'), { dataTransfer: transfer })
    folderBoard.mockResolvedValue([{ label: 'Inbox', category: 'backlog', status: 'new', droppable: true }, ...COLUMNS])
    await act(async () => { await client.invalidateQueries({ queryKey: ['tasks'] }) })
    expect(folderBoard).toHaveBeenCalledTimes(2)
    // Let the query's observers hear the new answer (they are notified on a timer).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Todo', 'Up Next', 'Doing', 'Shipped', 'Someday'])
    fireEvent.dragEnd(card('f1'), { dataTransfer: transfer })
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Inbox', 'Todo', 'Up Next', 'Doing', 'Shipped', 'Someday'])
  })
})

describe('New task', () => {
  it('stays open with main’s refusal, then closes and opens the task on success', async () => {
    createTask.mockRejectedValueOnce(new Error("Error invoking remote method 'task:create': Error: That agent is unavailable. Choose another agent."))
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: '  Ship it  ' } })
    fireEvent.submit(within(dialog).getByLabelText('Title').closest('form')!)
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'That agent is unavailable. Choose another agent.')
    expect(screen.getByRole('dialog', { name: 'New task' })).toBe(dialog)
    expect(createTask).toHaveBeenCalledWith({ title: 'Ship it' })

    createTask.mockResolvedValueOnce(task('n1', { title: 'Ship it' }))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Create' })) })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull())
    expect(useUIStore.getState()).toMatchObject({ activeView: 'task', activeTaskId: 'n1', taskOpenedFromTasks: true })
  })

  it('sends More options only when they differ from main’s defaults', async () => {
    createTask.mockResolvedValue(task('n2'))
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'T' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'More options' }))
    fireEvent.change(within(dialog).getByLabelText(/^Goal/), { target: { value: 'The whole goal' } })
    fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: 'high' } })
    fireEvent.change(within(dialog).getByLabelText('Status'), { target: { value: 'open' } })
    const assignee = within(dialog).getByLabelText('Assignee')
    expect(within(assignee).getAllByRole('option').map((o) => o.textContent)).toEqual(['Unassigned', 'Writer', 'Reviewer'])
    fireEvent.change(assignee, { target: { value: 'agent-w' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add field' }))
    fireEvent.change(within(dialog).getByLabelText('Field 1 name'), { target: { value: 'area' } })
    fireEvent.change(within(dialog).getByLabelText('Field 1 value'), { target: { value: 'docs' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({
      title: 'T', goal: 'The whole goal', priority: 'high', status: 'open',
      assignee: { kind: 'agent', agentId: 'agent-w' }, customFields: { area: 'docs' }
    }))
  })

  it('refuses a reserved field name in the dialog without calling main', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'T' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'More options' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add field' }))
    fireEvent.change(within(dialog).getByLabelText('Field 1 name'), { target: { value: 'status' } })
    fireEvent.change(within(dialog).getByLabelText('Field 1 value'), { target: { value: 'x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(within(dialog).getByRole('alert').textContent).toMatch(/built-in/)
    expect(createTask).not.toHaveBeenCalled()
  })

  it('closes on Escape or an outside click only while the form is untouched', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    await act(async () => { fireEvent.mouseDown(document.body) })
    expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Half a thought' } })
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    await act(async () => { fireEvent.mouseDown(document.body) })
    expect(screen.getByRole('dialog', { name: 'New task' })).toBe(dialog)
    expect((within(dialog).getByLabelText('Title') as HTMLInputElement).value).toBe('Half a thought')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })) })
    expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull()
    expect(createTask).not.toHaveBeenCalled()
  })

  it('names the Status options by a folder agent’s own words, keeping their values', async () => {
    let answer!: (columns: TaskBoardColumn[]) => void
    folderBoard.mockImplementation(async (agentId) => agentId === 'agent-w'
      ? new Promise<TaskBoardColumn[]>((resolve) => { answer = resolve })
      : null)
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'More options' }))
    const options = (): [string, string | null][] => within(within(dialog).getByLabelText('Status')).getAllByRole('option')
      .map((option) => [(option as HTMLOptionElement).value, option.textContent])
    expect(options()).toEqual([['new', 'Backlog'], ['open', 'Ready']])
    fireEvent.change(within(dialog).getByLabelText('Status'), { target: { value: 'open' } })
    fireEvent.change(within(dialog).getByLabelText('Assignee'), { target: { value: 'agent-w' } })
    // While the folder's words are unknown, the category words.
    expect(options()).toEqual([['new', 'Backlog'], ['open', 'Ready']])
    await act(async () => { answer([
      { label: 'Inbox', category: 'backlog', status: 'new', droppable: true },
      { label: 'Todo', category: 'backlog', status: 'new', droppable: true },
      { label: 'Up Next', category: 'ready', status: 'open', droppable: true }
    ]) })
    await waitFor(() => expect(options()).toEqual([['new', 'Inbox'], ['open', 'Up Next']]))
    expect((within(dialog).getByLabelText('Status') as HTMLSelectElement).value).toBe('open')
    // An agent without a folder board: the category words again.
    fireEvent.change(within(dialog).getByLabelText('Assignee'), { target: { value: 'agent-r' } })
    await waitFor(() => expect(options()).toEqual([['new', 'Backlog'], ['open', 'Ready']]))
  })

  it('puts the goal’s default in its placeholder, not a sub-line', async () => {
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'More options' }))
    expect(within(dialog).getByLabelText('Goal').getAttribute('placeholder')).toBe('Defaults to the title')
  })
})

describe('empty', () => {
  it('says so in one line beside the New task button', async () => {
    listTasks.mockResolvedValue([])
    render(createElement(TasksView), { wrapper })
    expect(await screen.findByText('No tasks yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New task' })).toBeTruthy()
    expect(screen.queryByRole('region')).toBeNull()
  })
})

describe('the queue control, filtered to one folder agent', () => {
  function queue(overrides: Partial<AgentDispatchState> = {}): AgentDispatchState {
    return { agentId: 'agent-w', mode: 'manual', paused: null, running: null, next: null, waiting: null, ...overrides }
  }

  it('appears only while the filter names one agent whose queue Cinna works', async () => {
    dispatchList.mockResolvedValue([queue()])
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: /^Plan the launch/ })
    expect(screen.queryByRole('button', { name: /Run next/ })).toBeNull()
    // Reviewer has tasks but no queue (not in main's list): no control.
    act(() => useUIStore.setState({ tasksAgentFilter: 'agent:agent-r' }))
    await waitFor(() => expect(dispatchList).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Run next/ })).toBeNull()
    act(() => useUIStore.setState({ tasksAgentFilter: 'agent:agent-w' }))
    expect(await screen.findByRole('button', { name: /Run next/ })).toBeTruthy()
    // Typing in search moves nothing in or out.
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'zzz' } })
    expect(screen.getByRole('button', { name: /Run next/ })).toBeTruthy()
  })

  it('switches the run mode from the chevron menu, the current one checked', async () => {
    dispatchList.mockResolvedValue([queue()])
    setMode.mockResolvedValue({ ok: true, state: queue({ mode: 'one' }) })
    useUIStore.setState({ tasksAgentFilter: 'agent:agent-w' })
    render(createElement(TasksView), { wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Choose how the queue runs' }))
    const menu = screen.getByRole('menu', { name: 'Run mode' })
    const manual = within(menu).getByRole('menuitemradio', { name: /Manual/ })
    expect(manual.getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: /One at a time/ }).getAttribute('aria-checked')).toBe('false')
    // Healthy: the menu is the run mode alone.
    expect(within(menu).queryByRole('menuitem')).toBeNull()
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitemradio', { name: /One at a time/ })) })
    expect(setMode).toHaveBeenCalledWith('agent-w', 'one')
    expect(screen.queryByRole('menu', { name: 'Run mode' })).toBeNull()
  })

  it('moves focus into the menu, walks it with the arrows, and Escape returns focus to the chevron', async () => {
    dispatchList.mockResolvedValue([queue()])
    useUIStore.setState({ tasksAgentFilter: 'agent:agent-w' })
    render(createElement(TasksView), { wrapper })
    const chevron = await screen.findByRole('button', { name: 'Choose how the queue runs' })
    fireEvent.click(chevron)
    const menu = screen.getByRole('menu', { name: 'Run mode' })
    const [manual, one] = within(menu).getAllByRole('menuitemradio')
    await waitFor(() => expect(document.activeElement).toBe(manual))
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(one)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(manual)
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(one)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Run mode' })).toBeNull()
    expect(document.activeElement).toBe(chevron)
    expect(setMode).not.toHaveBeenCalled()
  })

  it('runs the next task and stays put; shows a refusal under the control without closing anything', async () => {
    dispatchList.mockResolvedValue([queue()])
    runNext.mockResolvedValueOnce({ ok: true, taskId: 'r1', chatId: 'c9' })
    useUIStore.setState({ tasksAgentFilter: 'agent:agent-w' })
    render(createElement(TasksView), { wrapper })
    const button = await screen.findByRole('button', { name: /Run next/ })
    await act(async () => { fireEvent.click(button) })
    expect(runNext).toHaveBeenCalledWith('agent-w', undefined)
    expect(useUIStore.getState().activeView).toBe('tasks')
    expect(screen.queryByRole('alert')).toBeNull()

    runNext.mockResolvedValueOnce({ ok: false, code: 'folder_busy', message: 'Another task is running in this folder.' })
    await act(async () => { fireEvent.click(button) })
    expect(screen.getByRole('alert').textContent).toBe('Another task is running in this folder.')
    expect(useUIStore.getState().activeView).toBe('tasks')
    expect(screen.getByRole('button', { name: /Run next/ })).toBe(button)
  })

  it('opens the Inbox on the approval a gated task waits for', async () => {
    dispatchList.mockResolvedValue([queue()])
    runNext.mockResolvedValue({ ok: true, gate: 'gate-7' })
    useUIStore.setState({ tasksAgentFilter: 'agent:agent-w' })
    render(createElement(TasksView), { wrapper })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Run next/ })) })
    expect(useUIStore.getState().activeView).toBe('inbox')
    expect(useUIStore.getState().revealInboxGateId).toBe('gate-7')
  })

  it('turns Run next into Resume while paused, adding no row, with the task and Run next in the menu', async () => {
    const paused = queue({ paused: { reason: 'unreported', taskId: 'r1', taskTitle: 'Write the changelog', at: 1 } })
    dispatchList.mockResolvedValue([queue()])
    useUIStore.setState({ tasksAgentFilter: 'agent:agent-w' })
    render(createElement(TasksView), { wrapper })
    await screen.findByRole('button', { name: 'Run next' })
    const header = document.querySelector('header')!
    const after = header.nextElementSibling

    // A poll pauses the queue: the control changes in place, nothing is inserted under the row.
    dispatchList.mockResolvedValue([paused])
    await act(async () => { dispatchChanged?.() })
    const resumeButton = await screen.findByRole('button', { name: 'Resume' })
    expect(screen.queryByRole('button', { name: 'Run next' })).toBeNull()
    expect(header.nextElementSibling).toBe(after)
    expect(document.querySelector('[data-dispatch-paused]')!.closest('header')).toBe(header)
    const glyph = within(resumeButton).getByRole('img', { name: 'Paused — Write the changelog ended without reporting' })
    expect(glyph.getAttribute('title')).toBe('Paused — Write the changelog ended without reporting')
    expect(resumeButton.className).toContain('--color-warning')

    // The menu: the paused task, then Run next, then the run mode.
    fireEvent.click(screen.getByRole('button', { name: 'Choose how the queue runs' }))
    const menu = screen.getByRole('menu', { name: 'Run mode' })
    const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['Open Write the changelog', 'Run next', 'Manual', 'One at a time'])
    runNext.mockResolvedValueOnce({ ok: true, taskId: 'r2', chatId: 'c2' })
    await act(async () => { fireEvent.click(items[1]) })
    expect(runNext).toHaveBeenCalledWith('agent-w', undefined)

    fireEvent.click(screen.getByRole('button', { name: 'Choose how the queue runs' }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Run mode' })).getByRole('menuitem', { name: 'Open Write the changelog' }))
    expect(useUIStore.getState().activeTaskId).toBe('r1')
  })

  it('resumes from the control and shows a refusal under it', async () => {
    const paused = queue({ paused: { reason: 'unreported', taskId: 'r1', taskTitle: 'Write the changelog', at: 1 } })
    dispatchList.mockResolvedValue([paused])
    resume.mockResolvedValueOnce({ ok: false, code: 'not_dispatchable', message: 'This agent is disabled.' })
    useUIStore.setState({ tasksAgentFilter: 'agent:agent-w' })
    render(createElement(TasksView), { wrapper })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Resume' })) })
    expect(resume).toHaveBeenCalledWith('agent-w')
    expect(screen.getByRole('alert').textContent).toBe('This agent is disabled.')

    // The queue resumes: the control goes back to Run next on the dispatch event, not on a keystroke.
    dispatchList.mockResolvedValue([queue()])
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'W' } })
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
    await act(async () => { dispatchChanged?.() })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run next' })).toBeTruthy())
  })
})
