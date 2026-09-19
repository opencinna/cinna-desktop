import { fireEvent, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobRunData } from '../../../../shared/jobs'

/**
 * A row of the job page's Tasks history: where it goes, and what it says.
 *
 * **The task, not the chat.** A task outlives the conversation it ran in — that
 * chat is hidden from the Chats list, and deleting the task deletes it — so the
 * task is the record of the work (§5.8 of the agent runtime plan). The
 * conversation is one click further, from the task page's Open the chat.
 *
 * Rows with **no** task keep what they did: a run from before the tasks table
 * opens its chat, a cinna run without one the service's run view. A row with
 * nothing to open is not a button.
 *
 * Every task a job creates carries the job's title, which is the page heading,
 * so the row is told apart by when the run started; where it stands is the
 * leading icon, and the word is in the accessible name (`ux_rules.md` §10).
 */

const openChat = vi.hoisted(() => vi.fn())
const openTask = vi.hoisted(() => vi.fn())
const setActiveView = vi.hoisted(() => vi.fn())
const setActiveCinnaRunId = vi.hoisted(() => vi.fn())
const NOW = vi.hoisted(() => new Date(2026, 8, 19, 15, 0))

const deleteMutate = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useJobs', () => ({
  useOpenChatFromRun: () => openChat,
  useDeleteJobRun: () => ({ mutate: deleteMutate, isPending: false })
}))
vi.mock('../../hooks/useTasks', () => ({ useOpenTask: () => openTask }))
vi.mock('../../hooks/useRelativeNow', () => ({ useRelativeNow: () => NOW }))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setActiveView, setActiveCinnaRunId })
}))

const { JobRunRow } = await import('./JobRunRow')

function run(overrides: Partial<JobRunData> = {}): JobRunData {
  return {
    refreshMode: 'none',
    id: 'run-1',
    jobId: 'job-1',
    userId: 'u1',
    type: 'local',
    localChatId: 'chat-1',
    cinnaTaskId: null,
    cinnaShortCode: null,
    status: 'succeeded',
    errorMessage: null,
    taskId: 'task-1',
    startedAt: new Date(2026, 8, 19, 14, 2),
    finishedAt: new Date(2026, 8, 19, 14, 27),
    createdAt: new Date(2026, 8, 19, 14, 2),
    chatHidden: false,
    taskLive: true,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('what the row says', () => {
  it('names the run by when it started and where it stands, and shows how long it took', () => {
    render(createElement(JobRunRow, { run: run() }))
    // The clock format is the system locale's, so only the day word is pinned.
    const row = screen.getByRole('button', { name: /^Today \S.* — succeeded$/ })
    expect(row.textContent).toMatch(/^Today .+25 min$/)
  })

  it('shows no duration while a run is running or pending, even with a stray finish time', () => {
    const { unmount } = render(createElement(JobRunRow, {
      run: run({ status: 'running', startedAt: new Date(2026, 8, 19, 14, 30) })
    }))
    expect(screen.getByRole('button', { name: /running$/ }).textContent).toMatch(/^Today [^m]+$/)
    unmount()
    render(createElement(JobRunRow, {
      run: run({ status: 'pending', finishedAt: null, startedAt: null, createdAt: new Date(2026, 8, 18, 9, 15) })
    }))
    const row = screen.getByRole('button', { name: /^Yesterday \S.* — pending$/ })
    expect(row.textContent).toMatch(/^Yesterday [^m]+$/)
  })

  it('puts a failure’s reason in the row’s name, not only in the icon’s nested tooltip', () => {
    render(createElement(JobRunRow, { run: run({ status: 'failed', errorMessage: 'The agent crashed' }) }))
    screen.getByRole('button', { name: /^Today \S.* — failed: The agent crashed$/ })
  })

  it('carries no per-row actions', () => {
    render(createElement(JobRunRow, { run: run({ chatHidden: true, refreshMode: 'bound_task' }) }))
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('where the row goes', () => {
  it('opens the task when there is one, even with a chat', () => {
    render(createElement(JobRunRow, { run: run() }))
    screen.getByRole('button', { name: /succeeded/ }).click()
    expect(openTask).toHaveBeenCalledWith('task-1')
    expect(openChat).not.toHaveBeenCalled()
  })

  it('opens the task of a run executing on a service', () => {
    render(createElement(JobRunRow, {
      run: run({ type: 'cinna_task', localChatId: null, cinnaTaskId: 'ct-1', cinnaShortCode: 'ABC' })
    }))
    screen.getByRole('button', { name: /succeeded/ }).click()
    expect(openTask).toHaveBeenCalledWith('task-1')
    expect(setActiveView).not.toHaveBeenCalled()
  })

  it('opens the chat of a run with no task, exactly as it did before', () => {
    render(createElement(JobRunRow, { run: run({ taskId: null, taskLive: false }) }))
    screen.getByRole('button', { name: /succeeded/ }).click()
    expect(openChat).toHaveBeenCalledWith('chat-1')
    expect(openTask).not.toHaveBeenCalled()
  })

  it('sends a cinna run with no task to the cinna screen, which is where its content is', () => {
    render(createElement(JobRunRow, {
      run: run({ type: 'cinna_task', taskId: null, taskLive: false, localChatId: null, cinnaTaskId: 'ct-1', cinnaShortCode: 'ABC' })
    }))
    screen.getByRole('button', { name: /succeeded/ }).click()
    expect(setActiveCinnaRunId).toHaveBeenCalledWith('run-1')
    expect(setActiveView).toHaveBeenCalledWith('cinna-task-run')
    expect(openTask).not.toHaveBeenCalled()
  })

  it('is not a button when there is nothing to open, and says why and where it stands in text', () => {
    render(createElement(JobRunRow, {
      run: run({ taskId: null, taskLive: false, localChatId: null, status: 'failed', errorMessage: 'The agent crashed' })
    }))
    // Only its ⋯: the part that would open is not a button.
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Run actions'])
    // Text in the row, not a tooltip: nobody finds a `title` without hovering.
    expect(screen.getByText('Chat deleted')).toBeTruthy()
    expect(screen.getByText(/failed: The agent crashed/)).toBeTruthy()
  })

  it('says a cinna run with nothing to open has nothing to open', () => {
    render(createElement(JobRunRow, {
      run: run({ type: 'cinna_task', taskId: null, taskLive: false, localChatId: null, cinnaTaskId: null })
    }))
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Run actions'])
    expect(screen.getByText('Nothing to open')).toBeTruthy()
  })
})

describe('a run whose task is gone', () => {
  it('offers ⋯ always, where a run with a live task has none', () => {
    const { unmount } = render(createElement(JobRunRow, { run: run() }))
    expect(screen.queryByRole('button', { name: 'Run actions' })).toBeNull()
    unmount()
    render(createElement(JobRunRow, { run: run({ taskLive: false }) }))
    expect(screen.getByRole('button', { name: 'Run actions' })).toBeTruthy()
  })

  it('opens its chat rather than a task that is not there', () => {
    render(createElement(JobRunRow, { run: run({ taskLive: false }) }))
    screen.getByRole('button', { name: /succeeded$/ }).click()
    expect(openChat).toHaveBeenCalledWith('chat-1')
    expect(openTask).not.toHaveBeenCalled()
  })

  it('puts ⋯ before the duration, so the duration stays last as on every row', () => {
    const { container } = render(createElement(JobRunRow, { run: run({ taskLive: false }) }))
    const row = container.firstElementChild as HTMLElement
    expect(row.lastElementChild?.textContent).toBe('25 min')
    expect(row.lastElementChild?.previousElementSibling?.getAttribute('aria-label')).toBe('Run actions')
  })

  it('does not nest the ⋯ inside the button that opens', () => {
    render(createElement(JobRunRow, { run: run({ taskLive: false }) }))
    const opener = screen.getByRole('button', { name: /succeeded$/ })
    expect(within(opener).queryByRole('button')).toBeNull()
  })

  function openDelete(over: Partial<JobRunData> = {}): HTMLElement {
    render(createElement(JobRunRow, { run: run({ taskLive: false, ...over }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Run actions' }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Run actions' })).getByRole('menuitem', { name: 'Delete run…' }))
    return screen.getByRole('dialog', { name: 'Delete run' })
  }

  it('deletes the run through job:delete-run, saying the chat goes with it', () => {
    const dialog = openDelete()
    expect(dialog.querySelector('p')?.textContent).toBe(
      "The job stays. This run and the chat it ran in are permanently deleted — this can't be undone."
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(deleteMutate).toHaveBeenCalledWith({ jobId: 'job-1', runId: 'run-1' }, expect.anything())
  })

  it('names only the run when it has no chat', () => {
    const dialog = openDelete({ localChatId: null })
    expect(dialog.querySelector('p')?.textContent).toBe(
      "The job stays. This run is permanently deleted — this can't be undone."
    )
  })

  it('stays open with the reason when the delete fails', () => {
    deleteMutate.mockImplementation((_v: unknown, opts: { onError: (e: Error) => void }) =>
      opts.onError(new Error("Error invoking remote method 'job:delete-run': JobError: Job run not found"))
    )
    const dialog = openDelete()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('dialog', { name: 'Delete run' })).toBeTruthy()
    expect(within(dialog).getByRole('alert').textContent).toBe('Job run not found')
  })
})
