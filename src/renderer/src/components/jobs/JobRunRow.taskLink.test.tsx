import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobRunData } from '../../../../shared/jobs'

/**
 * Where a run row goes when it is clicked.
 *
 * **The task, not the chat.** A task outlives the conversation it ran in — that
 * chat is hidden from the Chats list, and deleting the run deletes it — so the
 * task is the record of the work and the run row is the record of the job's
 * attempt at it (§5.8 of the agent runtime plan). The conversation stays one
 * click away as its own labelled action, which is the part that makes the
 * change safe: nothing the user could reach before is now unreachable.
 *
 * The rows that have **no** task keep exactly what they did. A run from before
 * the tasks table is history, and a `cinna_task` run does not create one until
 * step 11 folds that path onto the task adapter; both would otherwise land on a
 * page with nothing to show.
 */

const openChat = vi.hoisted(() => vi.fn())
const openTask = vi.hoisted(() => vi.fn())
const setActiveView = vi.hoisted(() => vi.fn())
const setActiveCinnaRunId = vi.hoisted(() => vi.fn())

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}))
vi.mock('../../hooks/useJobs', () => ({
  useOpenChatFromRun: () => openChat,
  useDeleteJobRun: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('../../hooks/useTasks', () => ({ useOpenTask: () => openTask }))
vi.mock('../../hooks/useCinna', () => ({
  useRefreshCinnaRun: () => ({ mutate: vi.fn(), isPending: false }),
  useCinnaServerUrl: () => ({ data: null })
}))
vi.mock('../../hooks/useSystem', () => ({ useOpenExternal: () => vi.fn() }))
vi.mock('../../hooks/useCinnaTaskView', () => ({
  useCinnaTaskView: () => ({ data: undefined, error: null, isLoading: false })
}))
vi.mock('../../hooks/useChat', () => ({ useShowChatInList: () => ({ mutate: vi.fn() }) }))
vi.mock('../../hooks/useRelativeNow', () => ({ useRelativeNow: () => new Date(0) }))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setActiveView, setActiveCinnaRunId })
}))

const { JobRunRow } = await import('./JobRunRow')

function run(overrides: Partial<JobRunData> = {}): JobRunData {
  return {
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
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(0),
    chatHidden: false,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a run row with a task', () => {
  it('opens the task', () => {
    render(createElement(JobRunRow, { run: run() }))
    screen.getByRole('button', { name: /Succeeded/ }).click()
    expect(openTask).toHaveBeenCalledWith('task-1')
    expect(openChat).not.toHaveBeenCalled()
  })

  it('still offers the conversation, as a control that is visible without hovering', () => {
    // `ux_rules.md` §11: the row's click now opens the task, so this is the
    // only route to the chat from Run history — and a control that only appears
    // on `:hover` is one nobody who has not already guessed it finds. It is
    // named, at rest, outside the hover strip.
    render(createElement(JobRunRow, { run: run() }))
    screen.getByRole('button', { name: 'Chat' }).click()
    expect(openChat).toHaveBeenCalledWith('chat-1')
    // The row's own click must not also fire — the action is inside the row.
    expect(openTask).not.toHaveBeenCalled()
  })

  it('names what it opens, rather than the thing it used to', () => {
    // Mutation: drop the `canOpenTask ? 'Task'` arm and this fails — the row
    // reads "Local chat" over a tooltip and a destination that are both the
    // task, and its accessible name carries the wrong word with it.
    render(createElement(JobRunRow, { run: run() }))
    const row = screen.getByRole('button', { name: /Succeeded/ })
    expect(row.textContent).toContain('Task')
    expect(row.textContent).not.toContain('Local chat')
  })

  it('offers no conversation when the chat it ran in was deleted', () => {
    render(createElement(JobRunRow, { run: run({ localChatId: null }) }))
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull()
    screen.getByRole('button', { name: /Succeeded/ }).click()
    expect(openTask).toHaveBeenCalledWith('task-1')
  })
})

describe('a run row with no task', () => {
  it('opens the chat, exactly as it did before', () => {
    render(createElement(JobRunRow, { run: run({ taskId: null }) }))
    screen.getByRole('button', { name: /Succeeded/ }).click()
    expect(openChat).toHaveBeenCalledWith('chat-1')
    expect(openTask).not.toHaveBeenCalled()
  })

  it('sends a cinna run to the cinna screen, which is where its content is', () => {
    render(
      createElement(JobRunRow, {
        run: run({
          type: 'cinna_task',
          taskId: null,
          localChatId: null,
          cinnaTaskId: 'ct-1',
          cinnaShortCode: 'ABC'
        })
      })
    )
    screen.getByRole('button', { name: /Succeeded/ }).click()
    expect(setActiveCinnaRunId).toHaveBeenCalledWith('run-1')
    expect(setActiveView).toHaveBeenCalledWith('cinna-task-run')
    expect(openTask).not.toHaveBeenCalled()
  })
})
