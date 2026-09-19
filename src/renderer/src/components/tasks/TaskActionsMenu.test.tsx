import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDeletePreview, TaskDeleteResult, TaskDto } from '../../../../shared/tasks'

/**
 * The task page's ⋯ menu, driven against `window.api` fakes.
 *
 * "Show in the Chats list" must move a hidden chat out of hiding, point the
 * sidebar at its row and **stay on the task page**. "Delete task…" asks main
 * what the delete would remove, opens the confirm dialog with that copy already
 * final, and leaves the page only once main says it is done.
 */

const getChat = vi.fn()
const showInList = vi.fn()
const deleteTask = vi.fn<(taskId: string) => Promise<TaskDeleteResult>>()
const deletePreview = vi.fn<(taskId: string) => Promise<TaskDeletePreview>>()
const listRuns = vi.fn()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  chat: { get: (id: string) => getChat(id), showInList: (id: string) => showInList(id) },
  tasks: { delete: (id: string) => deleteTask(id), deletePreview: (id: string) => deletePreview(id) },
  jobs: { listRuns: (id: string) => listRuns(id) }
}

const { TaskActionsMenu } = await import('./TaskActionsMenu')
const { useUIStore } = await import('../../stores/ui.store')
const { useChatStore } = await import('../../stores/chat.store')

const TASK = {
  id: 't1',
  title: 'Nightly check',
  chatId: 'c1',
  jobId: 'j1',
  jobRunId: 'r1'
} as TaskDto


let client: QueryClient
const onDeleted = vi.fn()
const onError = vi.fn()

function mount(task: TaskDto = TASK): ReturnType<typeof render> {
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TaskActionsMenu, { task, onDeleted, onError })
    )
  )
}

/** The menu is drawn once the chat read has settled, so it is found, not got. */
async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
  return screen.findByRole('menu', { name: 'Task actions' })
}

/** Click "Delete task…" and wait for the dialog main's answer opens. */
async function openDeleteDialog(): Promise<HTMLElement> {
  fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Delete task…' }))
  return screen.findByRole('dialog', { name: 'Delete task' })
}

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  useUIStore.setState({ activeView: 'task', sidebarTab: 'jobs', sidebarOpen: true, revealChatId: null, activeJobId: null, activeCinnaRunId: null })
  useChatStore.setState({ activeChatId: null })
  getChat.mockResolvedValue({ id: 'c1', hiddenFromList: true, deletedAt: null, messages: [] })
  showInList.mockResolvedValue({ success: true })
  deletePreview.mockResolvedValue({ deletesRun: true, chat: 'deleted_with_run', jobStays: true })
  listRuns.mockResolvedValue([{ id: 'r1', jobId: 'j1', taskId: 't1', type: 'local', localChatId: 'c1', cinnaTaskId: null }])
})

describe('Show in the Chats list', () => {
  it('moves a hidden chat into the list and points the Chats sidebar at it, staying on the task', async () => {
    mount()
    const menu = await openMenu()
    const item = within(menu).getByRole('menuitem', { name: 'Show in the Chats list' })
    expect(item.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(item)
    await waitFor(() => expect(showInList).toHaveBeenCalledWith('c1'))
    const ui = useUIStore.getState()
    expect(ui.sidebarTab).toBe('chats')
    expect(ui.revealChatId).toBe('c1')
    expect(ui.activeView).toBe('task')
    expect(useChatStore.getState().activeChatId).toBeNull()
  })

  it('does not un-hide a chat that is already in the list, and still reveals it', async () => {
    getChat.mockResolvedValue({ id: 'c1', hiddenFromList: false, deletedAt: null, messages: [] })
    mount()
    const item = within(await openMenu()).getByRole('menuitem', { name: 'Show in the Chats list' })
    expect(item.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(item)
    expect(showInList).not.toHaveBeenCalled()
    expect(useUIStore.getState().revealChatId).toBe('c1')
  })

  it.each([
    ['was deleted', null, 'The chat was deleted.'],
    ['is in the Trash', { id: 'c1', hiddenFromList: true, deletedAt: new Date(), messages: [] }, 'The chat is in the Trash.']
  ])('is unavailable when the chat %s, and says why in text, not a tooltip', async (_case, chat, reason) => {
    getChat.mockResolvedValue(chat)
    mount()
    const item = within(await openMenu()).getByRole('menuitem', { name: 'Show in the Chats list' })
    // Focusable, so a keyboard reaches the reason; described by it, named without it.
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect((item as HTMLButtonElement).disabled).toBe(false)
    const describedBy = item.getAttribute('aria-describedby')
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(reason)
    expect(item.textContent).toContain(reason)
    expect(item.closest('[title]')).toBeNull()
    fireEvent.click(item)
    expect(showInList).not.toHaveBeenCalled()
    expect(useUIStore.getState().revealChatId).toBeNull()
  })

  it('withdraws the reveal when the move fails, even once the page has gone', async () => {
    let fail!: (err: Error) => void
    showInList.mockImplementation(() => new Promise((_, reject) => { fail = reject }))
    const { unmount } = mount()
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Show in the Chats list' }))
    expect(useUIStore.getState().revealChatId).toBe('c1')
    await waitFor(() => expect(showInList).toHaveBeenCalledWith('c1'))
    unmount()
    await act(async () => fail(new Error('disk I/O error')))
    await waitFor(() => expect(useUIStore.getState().revealChatId).toBeNull())
  })

  it('is not offered for a task with no chat', async () => {
    mount({ ...TASK, chatId: null })
    expect(within(await openMenu()).queryByRole('menuitem', { name: 'Show in the Chats list' })).toBeNull()
  })
})

describe('Open on the server', () => {
  it('leads the menu for a task a Cinna run produced, and opens that run’s view under its job', async () => {
    listRuns.mockResolvedValue([{ id: 'r1', jobId: 'j1', taskId: 't1', type: 'cinna_task', localChatId: null, cinnaTaskId: 'ct-9' }])
    mount()
    const menu = await openMenu()
    const items = within(menu).getAllByRole('menuitem')
    expect(items[0].textContent).toBe('Open on the server')
    fireEvent.click(items[0])
    // The run view resolves the run through the active job's runs; opened
    // from the Inbox there is no active job until this sets it.
    expect(useUIStore.getState().activeJobId).toBe('j1')
    expect(useUIStore.getState().activeCinnaRunId).toBe('r1')
    expect(useUIStore.getState().activeView).toBe('cinna-task-run')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each([
    ['a local run', [{ id: 'r1', jobId: 'j1', taskId: 't1', type: 'local', localChatId: 'c1', cinnaTaskId: null }]],
    ['a Cinna run not yet on the service', [{ id: 'r1', jobId: 'j1', taskId: 't1', type: 'cinna_task', localChatId: null, cinnaTaskId: null }]],
    ['a Cinna run that belongs to another task', [{ id: 'r1', jobId: 'j1', taskId: 'other', type: 'cinna_task', localChatId: null, cinnaTaskId: 'ct-9' }]]
  ])('is not offered for %s', async (_case, runs) => {
    listRuns.mockResolvedValue(runs)
    mount()
    expect(within(await openMenu()).queryByRole('menuitem', { name: 'Open on the server' })).toBeNull()
  })

  it('is not offered, and nothing is read, for a task no job run produced', async () => {
    mount({ ...TASK, jobId: null, jobRunId: null })
    expect(within(await openMenu()).queryByRole('menuitem', { name: 'Open on the server' })).toBeNull()
    expect(listRuns).not.toHaveBeenCalled()
  })

  it('draws the menu only once the run is known, so no item arrives after it opens', async () => {
    let answer!: (runs: unknown[]) => void
    listRuns.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    // No chat, so the run is the only read the menu waits for.
    mount({ ...TASK, chatId: null })
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    await waitFor(() => expect(listRuns).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByRole('menu')).toBeNull()
    await act(async () => answer([{ id: 'r1', jobId: 'j1', taskId: 't1', type: 'cinna_task', localChatId: null, cinnaTaskId: 'ct-9' }]))
    const menu = await screen.findByRole('menu', { name: 'Task actions' })
    expect(within(menu).getAllByRole('menuitem')[0].textContent).toBe('Open on the server')
  })
})

describe('Delete task', () => {
  it.each<[string, TaskDeletePreview, string]>([
    [
      'the run and its chat go',
      { deletesRun: true, chat: 'deleted_with_run', jobStays: true },
      "Delete Nightly check? The job stays. This run of it and the chat it ran in are permanently deleted with the task — this can't be undone."
    ],
    [
      'the run goes, with no chat',
      { deletesRun: true, chat: 'none', jobStays: true },
      "Delete Nightly check? The job stays. This run of it is permanently deleted with the task — this can't be undone."
    ],
    [
      'a soft-deleted job keeps its run, which goes with its chat',
      { deletesRun: true, chat: 'deleted_with_run', jobStays: false },
      "Delete Nightly check? The job run it came from and the chat it ran in are permanently deleted with the task — this can't be undone."
    ],
    [
      'the chat stays',
      { deletesRun: false, chat: 'kept', jobStays: false },
      "Delete Nightly check? The chat it ran in stays. The task can't be restored."
    ],
    [
      'the chat is already in the Trash',
      { deletesRun: false, chat: 'in_trash', jobStays: true },
      "Delete Nightly check? The job stays. The chat it ran in is already in the Trash, and stays there. The task can't be restored."
    ],
    [
      'there is no chat',
      { deletesRun: false, chat: 'none', jobStays: false },
      "Delete Nightly check? The task can't be restored."
    ]
  ])('says what main says goes (%s)', async (_case, answer, copy) => {
    deletePreview.mockResolvedValue(answer)
    mount()
    const dialog = await openDeleteDialog()
    expect(deletePreview).toHaveBeenCalledWith('t1')
    expect(dialog.querySelector('p')?.textContent).toBe(copy)
  })

  it('opens the dialog only once the preview is in, the item showing it is busy meanwhile', async () => {
    let answer!: (p: TaskDeletePreview) => void
    deletePreview.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    mount()
    const item = within(await openMenu()).getByRole('menuitem', { name: 'Delete task…' }) as HTMLButtonElement
    fireEvent.click(item)
    await waitFor(() => expect(item.getAttribute('aria-busy')).toBe('true'))
    expect(item.disabled).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => answer({ deletesRun: false, chat: 'kept', jobStays: false }))
    expect(await screen.findByRole('dialog', { name: 'Delete task' })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows why the preview failed in the menu, and opens no dialog', async () => {
    deletePreview.mockRejectedValue(new Error("Error invoking remote method 'task:delete-preview': TaskError: Task not found"))
    mount()
    const menu = await openMenu()
    const item = within(menu).getByRole('menuitem', { name: 'Delete task…' })
    fireEvent.click(item)
    const alert = await within(menu).findByRole('alert')
    expect(alert.textContent).toBe('Task not found')
    expect(item.getAttribute('aria-describedby')).toBe(alert.id)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteTask).not.toHaveBeenCalled()
  })

  it('deletes, drops the task’s own cache and leaves the page', async () => {
    deleteTask.mockResolvedValue({ success: true, jobRunId: 'r1', jobId: 'j1', chatId: 'c1', chatDeleted: true })
    useChatStore.setState({ activeChatId: 'c1' })
    client.setQueryData(['task', 't1'], { id: 't1' })
    mount()
    const dialog = await openDeleteDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(deleteTask).toHaveBeenCalledWith('t1')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(client.getQueryCache().find({ queryKey: ['task', 't1'] })).toBeUndefined()
    // The chat that went with it was the active one: nothing may keep asking for it.
    expect(useChatStore.getState().activeChatId).toBeNull()
  })

  it('keeps the dialog open with the reason when the delete fails, and cannot be dismissed while pending', async () => {
    let fail!: (err: Error) => void
    deleteTask.mockImplementation(() => new Promise((_, reject) => { fail = reject }))
    mount()
    const dialog = await openDeleteDialog()
    const confirm = within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    fireEvent.click(confirm)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Deleting…' })).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    expect(screen.getByRole('dialog', { name: 'Delete task' })).toBeTruthy()
    await act(async () => fail(new Error("Error invoking remote method 'task:delete': TaskError: Task not found")))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe('Task not found')
    // Below the buttons, so it moves neither of them.
    const buttons = within(dialog).getByRole('button', { name: 'Delete' }).parentElement as HTMLElement
    expect(buttons.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Delete task' })).toBeTruthy()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
