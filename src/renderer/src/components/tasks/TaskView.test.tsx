import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxEntry } from '../../../../shared/inbox'
import type { TaskDto } from '../../../../shared/tasks'
import type { TaskStatus } from '../../../../shared/taskStatus'

/**
 * The task page, driven.
 *
 * What is worth a test here is the state no other surface can see: a task that
 * is **`blocked` with nothing waiting on it**. The ask it stopped on expired
 * with the process holding it — the app restarted, the driver child was reaped
 * — so the inbox has no row, nothing is running, and no other screen in the app
 * can move the task out of `blocked`. `blocked` alone does not say which of the
 * two it is, which is why this page reads the inbox as well as the task, and
 * why the two branches below are the ones that matter.
 */

const getTask = vi.fn<() => Promise<TaskDto>>()
const listInbox = vi.fn<() => Promise<InboxEntry[]>>()
const getChat = vi.fn()
const setStatus = vi.fn<(taskId: string, status: TaskStatus) => Promise<TaskDto>>()
const runSend = vi.fn()
const openExternal = vi.fn<(url: string) => Promise<{ success: boolean; error?: string }>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  tasks: {
    get: () => getTask(),
    setStatus: (taskId: string, status: TaskStatus) => setStatus(taskId, status)
  },
  inbox: { list: () => listInbox() },
  agents: {
    list: async () => [{ id: 'a1', name: 'Invoice Checker' }],
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {},
    checkReadiness: async () => undefined
  },
  jobs: { get: async () => ({ id: 'j1', title: 'Nightly check' }) },
  chat: { get: (chatId: string) => getChat(chatId) },
  run: {
    send: (chatId: string, content: string, _cb: unknown, extras: unknown) =>
      runSend(chatId, content, extras)
  },
  system: { openExternal: (url: string) => openExternal(url) }
}

const { TaskView } = await import('./TaskView')
const { useUIStore } = await import('../../stores/ui.store')
const { useChatStore } = await import('../../stores/chat.store')

const BASE: TaskDto = {
  id: 't1',
  title: 'Check the invoices',
  goal: 'Look at every invoice from August.',
  description: null,
  status: 'blocked',
  priority: 'normal',
  router: 'direct',
  origin: 'local',
  executor: 'desktop',
  executorDevice: null,
  chatId: 'c1',
  assignee: { agentId: 'a1', name: 'Invoice Checker', kind: 'agent' },
  parentTaskId: null,
  subtaskCount: 0,
  subtaskCompletedCount: 0,
  remote: null,
  handoffNote: null,
  artifacts: [],
  budget: null,
  errorMessage: null,
  jobId: 'j1',
  jobRunId: 'r1',
  createdAt: new Date('2026-09-11T09:00:00Z'),
  updatedAt: new Date('2026-09-11T09:30:00Z'),
  startedAt: new Date('2026-09-11T09:05:00Z'),
  finishedAt: null
}

const WAITING: InboxEntry = {
  requestId: 'per_1',
  source: 'local',
  taskId: 't1',
  taskTitle: 'Check the invoices',
  chatId: 'c1',
  agentId: 'a1',
  request: { kind: 'permission', action: 'bash', resources: ['rm -rf build'] },
  resume: 'reply',
  createdAt: new Date('2026-09-11T10:00:00Z')
}

let client: QueryClient

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

async function renderTask(task: Partial<TaskDto> = {}): Promise<void> {
  getTask.mockResolvedValue({ ...BASE, ...task })
  render(createElement(TaskView), { wrapper })
  await screen.findByRole('heading', { level: 1 })
}

beforeEach(() => {
  vi.clearAllMocks()
  // No `gcTime: 0` — a fresh client per test already isolates them, and zero
  // would collect `['chat', …]` the instant `fetchQuery` wrote it, which is the
  // one thing the re-run below relies on surviving to the next statement.
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } }
  })
  listInbox.mockResolvedValue([])
  getChat.mockResolvedValue({
    id: 'c1',
    messages: [
      { id: 'm1', role: 'user', content: 'Check August', addressedAgentId: 'a1' },
      { id: 'm2', role: 'assistant', content: 'Working on it' }
    ]
  })
  setStatus.mockResolvedValue(BASE)
  openExternal.mockResolvedValue({ success: true })
  useUIStore.setState({ activeView: 'task', activeTaskId: 't1', activeJobId: null } as never)
  useChatStore.setState({ activeChatId: null } as never)
})

describe('a blocked task with nothing waiting on it', () => {
  it('offers a re-run, because nothing else in the app can move it', async () => {
    await renderTask()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Re-run from the last message/ })
      ).toBeTruthy()
    )
    expect(screen.queryByRole('button', { name: 'Open the Inbox' })).toBeNull()
  })

  it('sends the last user message again and lands the user in the conversation', async () => {
    await renderTask()
    const button = await screen.findByRole('button', { name: /Re-run from the last message/ })
    await act(async () => {
      button.click()
    })

    // The task is re-opened *before* the send: a turn must never stream into a
    // task that still reads as blocked, and a refusal here has to stop the run.
    expect(setStatus).toHaveBeenCalledWith('t1', 'in_progress')
    // The last **user** message, not the last message.
    expect(runSend).toHaveBeenCalledWith('c1', 'Check August', {
      attachments: undefined,
      addressedAgentId: 'a1'
    })
    expect(useChatStore.getState().activeChatId).toBe('c1')
    expect(useUIStore.getState().activeView).toBe('chat')
    // Read through the cache the chat view itself uses, so `startRun`'s
    // optimistic bubble has a real baseline to retire against and the screen we
    // just navigated to is already warm.
    expect(client.getQueryData(['chat', 'c1'])).toBeTruthy()
  })

  it('keeps the control and says why when there is no message to send again', async () => {
    getChat.mockResolvedValue({ id: 'c1', messages: [] })
    await renderTask()
    const button = await screen.findByRole('button', { name: /Re-run from the last message/ })
    await act(async () => {
      button.click()
    })
    // `ux_rules.md` §6: the reason lands beside the control that produced it,
    // and the control stays — the surface closes on success only.
    await screen.findByText(/no message in this conversation to send again/)
    expect(screen.getByRole('button', { name: /Re-run from the last message/ })).toBeTruthy()
    expect(runSend).not.toHaveBeenCalled()
    // Nothing was started, so nothing claimed the task either.
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('does not start the run when the task refuses to re-open', async () => {
    setStatus.mockRejectedValue(
      new Error("Error invoking remote method 'task:set-status': This task is running on a connected service")
    )
    await renderTask()
    const button = await screen.findByRole('button', { name: /Re-run from the last message/ })
    await act(async () => {
      button.click()
    })
    await screen.findByText(/running on a connected service/)
    expect(runSend).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeView).toBe('task')
  })
})

describe('a blocked task that is genuinely waiting', () => {
  it('points at the inbox instead of offering a re-run', async () => {
    listInbox.mockResolvedValue([WAITING])
    await renderTask()
    await screen.findByText(/waiting on an answer from you/)
    expect(screen.getByRole('button', { name: 'Open the Inbox' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
  })

  it('counts only the asks that belong to this task', async () => {
    listInbox.mockResolvedValue([WAITING, { ...WAITING, requestId: 'per_2', taskId: 'other' }])
    await renderTask()
    await screen.findByText(/waiting on an answer from you\./)
  })
})

describe('a blocked task whose inbox cannot be read', () => {
  it('offers no re-run, because an unread inbox is not an empty one', async () => {
    // Mutation: count `inbox.data ?? []` and drop `known`, and this fails — the
    // page offers to send a second message into a turn that may be parked and
    // waiting for an answer, which is the one thing a re-run must never do.
    listInbox.mockRejectedValue(new Error('database is locked'))
    await renderTask()
    // `useInboxList` retries once before it reports the failure, so this waits
    // past the default window.
    await screen.findByText(/What it is waiting on could not be read/, undefined, {
      timeout: 4000
    })
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()

    listInbox.mockResolvedValue([])
    screen.getByRole('button', { name: 'Try again' }).click()
    await screen.findByRole('button', { name: /Re-run from the last message/ })
  })
})

describe('a blocked task whose inbox went stale under it', () => {
  it('offers no re-run once the read starts failing, even with rows still cached', async () => {
    // The shape that actually happens. TanStack keeps the last good `data`
    // across a failed refetch, and `InboxButton` shares this key and keeps it
    // primed — so testing for `data === undefined` would have caught almost
    // nothing. Mutation: `known: inbox.data !== undefined` and this fails, and
    // the page offers to send a second message into a turn that may be parked.
    listInbox.mockResolvedValueOnce([])
    await renderTask()
    await screen.findByRole('button', { name: /Re-run from the last message/ })

    listInbox.mockRejectedValue(new Error('database is locked'))
    await act(async () => {
      await client.refetchQueries({ queryKey: ['inbox'] })
    })
    await screen.findByText(/What it is waiting on could not be read/, undefined, {
      timeout: 4000
    })
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
  })
})

describe('a failed task', () => {
  it('offers the same re-run, because a refused re-run lands here', async () => {
    // `error → in_progress` is the retry the transition table exists for, and
    // since a refused turn now reports itself as an ending, this is where a
    // re-run that could not start ends up. Without the arm, the one press that
    // can fail would have no second press.
    await renderTask({ status: 'error', errorMessage: 'Agent not found or not configured' })
    await screen.findByText('Agent not found or not configured')
    const button = await screen.findByRole('button', { name: /Re-run from the last message/ })
    await act(async () => {
      button.click()
    })
    expect(setStatus).toHaveBeenCalledWith('t1', 'in_progress')
    expect(runSend).toHaveBeenCalledWith('c1', 'Check August', {
      attachments: undefined,
      addressedAgentId: 'a1'
    })
  })
})

describe('a task whose conversation is gone', () => {
  it('says so instead of showing a control that can never work', async () => {
    // `ux_rules.md` §11's principle for a choice that is no longer valid: it
    // degrades to an explanation, not to a button that fails after the click —
    // and a disabled control whose only account of itself is a `title` tooltip
    // says nothing at all to a keyboard or touch user.
    await renderTask({ chatId: null })
    await screen.findByText(/nothing left to send again/)
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
  })
})

describe('the other states', () => {
  it('says the task could not be refreshed rather than passing a stale read off as current', async () => {
    // Mutation: drop `isStale` and this fails — a task that was deleted, or a
    // read that broke, keeps rendering its last status as if it were current
    // (`ux_rules.md` §6).
    await renderTask()
    getTask.mockRejectedValue(new Error('gone'))
    await act(async () => {
      await client.refetchQueries({ queryKey: ['task', 't1'] })
    })
    await screen.findByText('Showing the last read — this task could not be refreshed.')
    // And the last good read is still on screen, because it is still what is known.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Check the invoices')
  })

  it('shows no banner at all when the task is healthy', async () => {
    await renderTask({ status: 'completed', finishedAt: new Date('2026-09-11T10:00:00Z') })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('reports the error a failed run left behind, and one that recorded nothing', async () => {
    await renderTask({ status: 'error', errorMessage: 'The agent folder is gone' })
    await screen.findByText('The agent folder is gone')
    cleanup()
    await renderTask({ status: 'error', errorMessage: null })
    await screen.findByText('This task ended with an error.')
  })

  it('says a replica blocked in its own service is waiting there, not here', async () => {
    // Not the re-run sentence: the ask is over there, and so is the answer.
    // Offering to send a message into a conversation this device does not hold
    // would be a control that cannot do what it says.
    await renderTask({
      status: 'blocked',
      executor: 'remote',
      origin: 'remote',
      remote: { adapter: 'fake', id: 'x1', key: 'ENG-421', url: null }
    })
    await screen.findByText(/waiting on something in the service that is running it/)
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
  })

  it('renders a replica running in a connected service read-only', async () => {
    // Nothing produces one yet — the adapters land in steps 8–9 — but the page
    // binds to the shape rather than to what happens to fill it today. There is
    // no re-run here: the work is somewhere this device cannot start a turn.
    await renderTask({
      executor: 'remote',
      origin: 'remote',
      remote: { adapter: 'fake', id: 'x1', key: 'ENG-421', url: 'https://example.test/t/x1' }
    })
    await screen.findByText('ENG-421')
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Open this task in the service it is connected to' })
    ).toBeTruthy()
  })

  it('says why a link was refused, in words rather than in the wire\'s code', async () => {
    // `app:open-external` answers `unsupported_protocol` / `invalid_url`, which
    // is right for a main-process result and is not a sentence. A task's
    // artifacts are strings an agent wrote, so this is the surface that will
    // actually meet one (`ux_rules.md` §6).
    openExternal.mockResolvedValue({ success: false, error: 'unsupported_protocol' })
    await renderTask({
      artifacts: [{ kind: 'link', name: 'The pull request', ref: 'ftp://example.test/pr' }]
    })
    await act(async () => {
      screen.getByRole('button', { name: 'The pull request' }).click()
    })
    await screen.findByText('Only http and https links can be opened.')
    expect(screen.queryByText('unsupported_protocol')).toBeNull()
  })

  it('says a task could not be read rather than showing an empty page', async () => {
    getTask.mockRejectedValue(new Error("Error invoking remote method 'task:get': Task not found"))
    render(createElement(TaskView), { wrapper })
    // `useTask` retries once before it gives up (the page polls anyway, so
    // three would only delay the sentence) — hence a window past the default.
    await screen.findByText('This task could not be opened.', undefined, { timeout: 4000 })
    await screen.findByText('Task not found')
  })
})
