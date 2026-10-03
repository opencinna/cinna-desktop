import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDto } from '../../../../shared/tasks'

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
const setStatus = vi.fn<(id: string, status: string) => Promise<TaskDto>>()
const createTask = vi.fn<(input: unknown) => Promise<TaskDto>>()

const { TasksView } = await import('./TasksView')
const { useUIStore } = await import('../../stores/ui.store')

function task(id: string, overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id, title: `Task ${id}`, goal: 'g', description: null, status: 'new', priority: 'normal', router: 'direct',
    origin: 'local', executor: 'desktop', executorDevice: null, runsHere: true, chatId: null,
    assignee: { kind: 'model', agentId: null, name: null }, parentTaskId: null, subtaskCount: 0,
    subtaskCompletedCount: 0, remote: null, handoffNote: null, artifacts: [], budget: null, errorMessage: null,
    customFields: null, jobId: null, jobRunId: null, createdAt: new Date('2026-10-01T09:00:00Z'),
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
  createTask.mockReset()
  useUIStore.setState({ activeView: 'tasks', tasksViewMode: 'list', activeTaskId: null, taskOpenedFromTasks: false })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    tasks: {
      list: () => listTasks(),
      setStatus: (id: string, status: string) => setStatus(id, status),
      create: (input: unknown) => createTask(input)
    },
    inbox: { list: async () => ({ entries: [], unreadable: [] }) }
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
