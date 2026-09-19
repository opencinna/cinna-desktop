import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, within, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxEntry, InboxSnapshot, InboxUnreadableSource } from '../../../../shared/inbox'
import type { DelegationDto, TaskDelegationsDto } from '../../../../shared/delegations'
import type { HandoverDto } from '../../../../shared/handovers'
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

const getTask = vi.fn<(taskId?: string) => Promise<TaskDto>>()
const listInbox = vi.fn<() => Promise<InboxSnapshot>>()

/** One inbox read: what is waiting, and which services could not be asked. */
function inbox(entries: InboxEntry[], unreadable: InboxUnreadableSource[] = []): InboxSnapshot {
  return { entries, unreadable }
}
const getChat = vi.fn()
const getJob = vi.fn<(jobId: string) => Promise<unknown>>()
const setStatus = vi.fn<(taskId: string, status: TaskStatus) => Promise<TaskDto>>()
const takeOver = vi.fn<(taskId: string, force?: boolean) => Promise<TaskDto>>()
const remoteLive = vi.fn<(taskId: string) => Promise<boolean | null>>()
const runSend = vi.fn().mockResolvedValue('run-1')
const startTask = vi.fn()
const openExternal = vi.fn<(url: string) => Promise<{ success: boolean; error?: string }>>()
const delegationLinks = vi.fn<(taskId: string) => Promise<TaskDelegationsDto>>()
const forTask = vi.fn<(taskId: string) => Promise<HandoverDto | null>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  tasks: {
    list: async () => [],
    children: async () => ({ tasks: [], refreshed: true }),
    start: (taskId: string, target: unknown) => startTask(taskId, target),
    get: (taskId: string) => getTask(taskId),
    setStatus: (taskId: string, status: TaskStatus) => setStatus(taskId, status),
    takeOver: (taskId: string, force?: boolean) => takeOver(taskId, force),
    remoteLive: (taskId: string) => remoteLive(taskId)
  },
  inbox: { list: () => listInbox() },
  agents: {
    list: async () => [
      { id: 'a1', name: 'Invoice Checker', enabled: true },
      { id: 'folder:m1', name: 'Ledger Folder', enabled: true, source: 'folder' }
    ],
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {},
    checkReadiness: async () => undefined
  },
  jobs: { get: (jobId: string) => getJob(jobId) },
  delegations: { forTask: (taskId: string) => delegationLinks(taskId) },
  handovers: { forTask: (taskId: string) => forTask(taskId) },
  chat: { get: (chatId: string) => getChat(chatId) },
  run: {
    start: runSend
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
  runsHere: true,
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
  listInbox.mockResolvedValue(inbox([]))
  getJob.mockImplementation(async (jobId) => ({ id: jobId, title: 'Nightly check' }))
  getChat.mockResolvedValue({
    id: 'c1',
    messages: [
      { id: 'm1', role: 'user', content: 'Check August', addressedAgentId: 'a1' },
      { id: 'm2', role: 'assistant', content: 'Working on it' }
    ]
  })
  setStatus.mockResolvedValue(BASE)
  takeOver.mockResolvedValue({ ...BASE, runsHere: true, executorDevice: null })
  remoteLive.mockResolvedValue(false)
  openExternal.mockResolvedValue({ success: true })
  forTask.mockResolvedValue(null)
  delegationLinks.mockResolvedValue({ from: null, to: [] })
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
    expect(runSend).toHaveBeenCalledWith({ chatId: 'c1', content: 'Check August',
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

describe('the way back to a list of tasks', () => {
  it('goes back to the job from a job task, named after the job once it loads', async () => {
    await renderTask()
    const back = await screen.findByRole('button', { name: 'Back to Nightly check' })
    await act(async () => { back.click() })
    expect(useUIStore.getState().activeView).toBe('job-detail')
    expect(useUIStore.getState().activeJobId).toBe('j1')
  })

  it('gives a subtask with a job one arrow, to its parent, and the job in Details', async () => {
    await renderTask({ parentTaskId: 'p1' })
    expect(screen.getByRole('button', { name: 'Parent task' })).toBeTruthy()
    const details = screen.getByRole('complementary', { name: 'Details' })
    await waitFor(() => expect(within(details).getByRole('button', { name: 'Nightly check' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Back to Nightly check' })).toBeNull()
  })

  it('offers the Inbox to a task with neither a parent nor a job', async () => {
    // Mutation: drop the arm and this fails — with the sidebar's Tasks section
    // gone, a task a conversation minted at its first ask has no named route
    // back to a list of tasks at all. The only escape left is the top-bar icon,
    // which announces "Inbox" and nothing about tasks.
    await renderTask({ jobId: null, jobRunId: null })
    await act(async () => {
      screen.getByRole('button', { name: 'Back to the Inbox' }).click()
    })
    expect(useUIStore.getState().activeView).toBe('inbox')
  })

  it('leaves it off when the header already has one', async () => {
    // One arm each, most specific first. BASE carries a job, so the job link is
    // the way back and a second arrow beside it would be two controls for one
    // noun — the thing this header rejected once already.
    await renderTask()
    expect(screen.queryByRole('button', { name: 'Back to the Inbox' })).toBeNull()
  })

  it('leaves it off for a subtask, which goes up instead', async () => {
    await renderTask({ jobId: null, jobRunId: null, parentTaskId: 'p1' })
    expect(screen.getByRole('button', { name: 'Parent task' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to the Inbox' })).toBeNull()
  })
})

describe('a blocked task that is genuinely waiting', () => {
  it('points at the inbox instead of offering a re-run', async () => {
    listInbox.mockResolvedValue(inbox([WAITING]))
    await renderTask()
    await screen.findByText(/waiting on an answer from you/)
    expect(screen.getByRole('button', { name: 'Open the Inbox' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
  })

  it('counts only the asks that belong to this task', async () => {
    listInbox.mockResolvedValue(inbox([WAITING, { ...WAITING, requestId: 'per_2', taskId: 'other' }]))
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

    listInbox.mockResolvedValue(inbox([]))
    screen.getByRole('button', { name: 'Try again' }).click()
    await screen.findByRole('button', { name: /Re-run from the last message/ })
  })
})

describe('a blocked task while one service could not be read', () => {
  it('offers no re-run for a bound task, whose ask may be on the service that went quiet', async () => {
    // Mutation: leave `known` at `inbox.isSuccess` and this fails — the read
    // succeeded, so the page would treat an inbox with a known hole in it as
    // proof nothing is waiting and offer to send a second message into a task
    // that may be parked on a question in the other system.
    listInbox.mockResolvedValue(inbox([], [{ adapter: 'cinna', reason: 'offline' }]))
    await renderTask({
      remote: { adapter: 'cinna', id: 'task-there', key: null, url: null }
    })
    await screen.findByText(/This task is blocked\./)
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
    // Mutation: leave `failed` at `inbox.isError` and these two fail — the page
    // knows the read had a hole in it, says nothing about it, and offers no way
    // to ask again. It is the same sentence the rejected read earns, because it
    // is the same thing from where the user is standing.
    await screen.findByText(/What it is waiting on could not be read/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('still offers the re-run for a task with no remote binding at all', async () => {
    // The other half of the gate: a task bound to nothing can only have local
    // asks, and those came out of this device's database — complete the moment
    // the query resolved, whatever a service somewhere else did. Mutation: drop
    // the `|| !task.remote` arm and this fails, and one unreachable service
    // freezes the recovery action on every unrelated desktop task.
    listInbox.mockResolvedValue(inbox([], [{ adapter: 'cinna', reason: 'offline' }]))
    await renderTask()
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
    listInbox.mockResolvedValueOnce(inbox([]))
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
    expect(runSend).toHaveBeenCalledWith({ chatId: 'c1', content: 'Check August',
      attachments: undefined,
      addressedAgentId: 'a1'
    })
  })
})

describe('a task whose conversation is gone', () => {
  it('starts through main once and navigates only after acceptance', async () => {
    await renderTask({ chatId: null })
    await screen.findByRole('option', { name: 'Invoice Checker' })
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Continue with' }), { target: { value: 'a1' } })
    startTask.mockResolvedValueOnce({ task: { ...BASE, chatId: 'new-chat' }, chatId: 'new-chat', runId: 'turn1' })
    await act(async () => { screen.getByRole('button', { name: 'Continue' }).click() })
    expect(startTask).toHaveBeenCalledExactlyOnceWith('t1', { kind: 'agent', agentId: 'a1' })
    expect(runSend).not.toHaveBeenCalled()
    expect(useChatStore.getState().activeChatId).toBe('new-chat')
    expect(useUIStore.getState().activeView).toBe('chat')
  })

  it('keeps the selection and control when main refuses to start', async () => {
    await renderTask({ chatId: null })
    fireEvent.change(screen.getByRole('combobox', { name: 'Continue with' }), { target: { value: 'model' } })
    startTask.mockRejectedValueOnce(new Error("Error invoking remote method 'task:start': Error: Choose a default chat mode"))
    await act(async () => { screen.getByRole('button', { name: 'Continue' }).click() })
    expect((await screen.findByText('Choose a default chat mode')).textContent).not.toContain('Error invoking')
    expect((screen.getByRole('combobox', { name: 'Continue with' }) as HTMLSelectElement).value).toBe('model')
    fireEvent.change(screen.getByRole('combobox', { name: 'Continue with' }), { target: { value: 'a1' } })
    expect(screen.queryByText('Choose a default chat mode')).toBeNull()
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false)
    expect(runSend).not.toHaveBeenCalled()
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

  it('shows a remote refresh failure while the cached task IPC read succeeds', async () => {
    await renderTask({
      remote: { adapter: 'fake', id: 'x1', key: null, url: null, refreshError: 'Offline' }
    })
    await screen.findByText('Showing the last read — this task could not be refreshed.')
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

  describe('taking a task back from the service running it', () => {
    /**
     * The banner's content block — the status sentence's own parent, because
     * the sentence is the one row every arm always has text in.
     */
    const STATUS_SENTENCES = [
      'This task is running in the service that holds it.',
      'Listed as running, but nothing is working on it there.',
      'This task is waiting on something in the service that is running it.',
      'This task ended with an error in the service running it.'
    ]

    async function bannerBlock(): Promise<HTMLElement> {
      // Matched against the whole set rather than a fragment: a fragment finds
      // the liveness sub-line too, which lives in the same block, and two hits
      // is an error rather than an answer.
      const sentence = await screen.findByText((text) => STATUS_SENTENCES.includes(text))
      return sentence.parentElement as HTMLElement
    }

    const REMOTE: Partial<TaskDto> = {
      status: 'in_progress',
      executor: 'remote',
      origin: 'remote',
      remote: { adapter: 'fake', id: 'x1', key: 'ENG-421', url: null }
    }

    it('opens the inbox for a blocked remote task even while its agent is live', async () => {
      remoteLive.mockResolvedValue(true)
      listInbox.mockResolvedValue(inbox([{ ...WAITING, source: 'remote', chatId: null }]))
      await renderTask({ ...REMOTE, status: 'blocked', chatId: null })
      const button = await screen.findByRole('button', { name: 'Open the Inbox' })
      await act(async () => button.click())
      expect(useUIStore.getState().activeView).toBe('inbox')
      expect(takeOver).not.toHaveBeenCalled()
      expect(runSend).not.toHaveBeenCalled()
    })

    /**
     * §5.10, and the twin of decision 8's refusal for another device. The claim
     * does not stop the agent, so the two outcomes of pressing it are two
     * runners on one task and a claim the service's next status recompute
     * undoes. A button with those two outcomes is not a button.
     *
     * **`blocked` is the case that matters**, and it is the reason this asks
     * the adapter instead of reading `status`. cinna recomputes a task's status
     * *from* its sessions, so the status lags what the sessions are doing in
     * one direction and leads it in the other: a task can read `blocked` — an
     * agent parked on a question — with that same agent's session still very
     * much alive. Inferring "live" from `status === 'in_progress'` offers the
     * take-over on exactly that task, which is the race the rule exists to
     * prevent.
     */
    it.each(['in_progress', 'blocked'] as const)(
      'offers no take-over while an agent is working on it there (%s)',
      async (status) => {
        remoteLive.mockResolvedValue(true)
        await renderTask({ ...REMOTE, status })

        await waitFor(() => expect(remoteLive).toHaveBeenCalledWith('t1'))
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: /Take over/ })).toBeNull()
        )
      }
    )

    it('offers it once nothing is working on it there', async () => {
      remoteLive.mockResolvedValue(false)
      await renderTask(REMOTE)

      const button = await screen.findByRole('button', { name: 'Take over' })
      await act(async () => {
        button.click()
      })
      expect(takeOver).toHaveBeenCalledWith('t1', false)
    })

    it('says so and names what it will do when the service cannot tell', async () => {
      // Not a refusal: refusing here strands the task on a service that cannot
      // answer for it. The confirmation is the sentence plus the label, because
      // a take-over claims and does not run — nothing starts here and nothing
      // stops there.
      remoteLive.mockResolvedValue(null)
      await renderTask(REMOTE)

      await screen.findByText(/could not say whether anything is working on it/)
      const button = await screen.findByRole('button', { name: 'Take over anyway' })
      await act(async () => {
        button.click()
      })
      expect(takeOver).toHaveBeenCalledWith('t1', true)
    })

    it('offers a way out of a task whose service is no longer connected', async () => {
      // `unbindRemote` fires when a service answers "not yours" and does not
      // move the executor, so a replica can be `executor: 'remote'` with no
      // binding at all. Gated on `task.remote`, the probe never ran, the banner
      // read that as still in flight, and the page offered nothing for ever.
      remoteLive.mockResolvedValue(false)
      await renderTask({ ...REMOTE, remote: null })

      await screen.findByRole('button', { name: 'Take over' })
      expect(remoteLive).toHaveBeenCalledWith('t1')
    })

    /**
     * **The three liveness states each say exactly one thing about liveness.**
     *
     * This exists because of a defect no other test here could see: the fix
     * that stopped an errored probe being read as "not live" was written as
     * `live !== false`, which is also true for `true` — so the live arm
     * rendered "That service could not say…" *underneath* a sentence saying an
     * agent was working on it. Two statements contradicting each other one line
     * apart, and the second is the one that decides whether the control
     * appears. Every test around it asked what the **button** said, and the
     * button was right; only a re-measure of the screen caught it.
     *
     * **What this actually holds down**, checked rather than assumed: the fix
     * restructured the sub-line so `live === true` is tested *first*, which
     * makes the original `live !== false` mutation no longer reachable through
     * it — reverting that alone leaves these tests green, because the button is
     * still absent and the sentence is still chosen by the earlier branch. What
     * they do catch is the branch **order**: put `unknown` first, and the live
     * arm contradicts itself again. That is the shape the defect would take
     * next, so that is the one worth pinning.
     */
    it.each([
      [true, /An agent is working on it there now/, /could not say/],
      [false, /Listed as running, but nothing is working on it there/, /could not say|An agent is working/],
      [null, /could not say whether anything is working/, /An agent is working on it there now/]
    ] as const)('says one thing about liveness when the probe answers %s', async (
      answer,
      present,
      absent
    ) => {
      remoteLive.mockResolvedValue(answer)
      await renderTask(REMOTE)

      await screen.findByText(present)
      expect(screen.queryByText(absent)).toBeNull()
    })

    /**
     * **Exhaustive, not "is the expected thing present".**
     *
     * N1 was invisible to every assertion in this file because each one asked
     * whether something expected was there, and nothing asked whether anything
     * *unexpected* was — so a live arm carrying both "an agent is working on
     * it" and "the service could not say" passed them all. A screenshot is
     * exhaustive by construction, which is why the screen caught it and the
     * suite did not; asserting the banner's whole text is the cheap version of
     * the same property. The UX reviewer asked for this one by name.
     *
     * **What it does not catch**, checked rather than claimed: reverting
     * `unknown` to `live !== false`. The reviewer predicted it would, and that
     * prediction was made against the shape before the rework — the sub-line
     * now tests `live === true` first, so `unknown` is no longer reachable in
     * the live arm at all. What these do catch is the branch **order**, which
     * is the form the same defect would take next.
     */
    it.each([
      [
        true,
        'This task is running in the service that holds it.' +
          'An agent is working on it there now, so it cannot be taken over yet.'
      ],
      [false, 'Listed as running, but nothing is working on it there.' + 'Take over'],
      [
        null,
        'This task is running in the service that holds it.' +
          'That service could not say whether anything is working on it right now.' +
          'Take over anyway'
      ]
    ] as const)('says all and only what it means when the probe answers %s', async (
      answer,
      expected
    ) => {
      remoteLive.mockResolvedValue(answer)
      await renderTask(REMOTE)

      const block = await bannerBlock()
      await waitFor(() => expect(block.textContent).toBe(expected))
    })

    /**
     * **N2's actual property, which nothing else holds down.**
     *
     * The banner does not move when the probe resolves because every arm
     * renders the same rows in flight as resolved — sentence, liveness
     * sub-line, control row — with the sub-line's slot present whether or not
     * it has anything in it. A pixel `min-h` was the first attempt and could
     * not survive a wrap; this is the shape that can.
     *
     * It breaks the moment somebody renders the sub-line conditionally, which
     * is the natural tidy-up a future reader will want, because an empty `div`
     * looks like a mistake. jsdom has no layout, so this counts rows rather
     * than measuring them — the wrapping half was measured on the built app.
     */
    it.each([
      ['in_progress', null, 3],
      ['in_progress', false, 3],
      ['in_progress', true, 3],
      ['error', null, 4],
      ['error', false, 4]
    ] as const)(
      'holds the same rows in flight as resolved (%s, probe answers %s)',
      async (status, answerWith, rows) => {
        // **`false` is the case that matters**, and a first version of this
        // test used only `null`. With `null` the sub-line has something to say
        // either way, so rendering it conditionally — the tidy-up above — keeps
        // the row count identical and the test passes against the mutation it
        // was written for. `false` is the arm whose slot is *empty* once the
        // answer lands, which is exactly when a conditional render drops a row.
        let answer: (live: boolean | null) => void = () => {}
        remoteLive.mockImplementation(
          () => new Promise<boolean | null>((resolve) => (answer = resolve))
        )
        await renderTask({ ...REMOTE, status, errorMessage: 'The agent gave up.' })

        const block = await bannerBlock()
        expect(block.children).toHaveLength(rows)

        await act(async () => {
          answer(answerWith)
        })
        await waitFor(() =>
          expect(screen.queryByText(/Checking whether an agent is working/)).toBeNull()
        )
        expect(block.children).toHaveLength(rows)
      }
    )

    it('treats a probe that failed as “cannot tell”, not as “nothing is running”', async () => {
      // The least cautious reading of the three, and a dead end: the plain
      // label sent `force: false`, main refused with `remote_unknown`, the
      // label did not change, and the next press refused identically.
      remoteLive.mockRejectedValue(new Error('socket hang up'))
      await renderTask(REMOTE)

      const button = await screen.findByRole('button', { name: 'Take over anyway' })
      await act(async () => {
        button.click()
      })
      expect(takeOver).toHaveBeenCalledWith('t1', true)
    })

    it('asks the service again when a take-over is refused', async () => {
      // The same dead end reached with no error anywhere: the answer is cached
      // for a minute, so a `false` that has gone stale gets refused and the
      // label stays *Take over*. A re-read makes the next press the one that
      // works.
      remoteLive.mockResolvedValue(false)
      takeOver.mockRejectedValueOnce(new Error('could not say whether anything is working on it'))
      await renderTask(REMOTE)

      const button = await screen.findByRole('button', { name: 'Take over' })
      remoteLive.mockResolvedValue(null)
      await act(async () => {
        button.click()
      })

      await screen.findByRole('button', { name: 'Take over anyway' })
      expect(remoteLive).toHaveBeenCalledTimes(2)
    })

    it('asks the service nothing about a task this device is already running', async () => {
      // One request, for one question, and only where that question exists.
      await renderTask({ status: 'blocked', executor: 'desktop', remote: null })
      await screen.findByRole('button', { name: /Re-run from the last message/ })
      expect(remoteLive).not.toHaveBeenCalled()
    })
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

/**
 * A task another of the user's devices is running.
 *
 * Reachable only now that tasks sync. Everything the page would otherwise offer
 * — the re-run, the pointer at the Inbox — is something this device cannot do
 * to a run it does not hold: main refuses the write, and the ask is in the
 * inbox of the device that raised it, because `task_input_requests` never
 * syncs. So the only control here is the one that changes that.
 */
describe('a task running on another device', () => {
  const ELSEWHERE: Partial<TaskDto> = { runsHere: false, executorDevice: 'device-b' }

  it('offers to take it over instead of to re-run it', async () => {
    await renderTask({ ...ELSEWHERE, status: 'blocked' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take over' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
    expect(screen.getByText(/stopped on another of your devices/)).toBeTruthy()
  })

  /**
   * The one shape with no control at all, and the reason is not tidiness.
   * Taking over a live run does not stop it: the other device keeps streaming,
   * and its `reportRunCompletion` is then refused by `requireRunsHere` and
   * swallowed, leaving the task `in_progress` for ever — or it finishes first
   * and its whole record wins last-writer-wins, undoing the claim. Neither
   * outcome is one a button should offer.
   */
  it('reports a live run elsewhere and offers nothing to press', async () => {
    await renderTask({ ...ELSEWHERE, status: 'in_progress' })
    await waitFor(() =>
      expect(screen.getByText(/running on another of your devices/)).toBeTruthy()
    )
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull()
    // And nothing else this device cannot do, either.
    expect(screen.queryByRole('button', { name: /Re-run from the last message/ })).toBeNull()
  })

  /**
   * Every task a peer created carries that peer's `executor_device` from the
   * moment it was created, and nothing clears it. So a rule written as "say
   * something unless the work is over" put this banner on every task the user
   * had ever made on their other machine — on statuses where this page offers
   * nothing anyway, which is `ux_rules.md` §2's definition of noise.
   */
  it.each(['new', 'open', 'refining'] as const)(
    'says nothing about a claim on a %s task, which offers nothing anyway',
    async (status) => {
      await renderTask({ ...ELSEWHERE, status })
      await screen.findByRole('heading', { level: 1 })
      expect(screen.queryByRole('status')).toBeNull()
    }
  )

  /**
   * The measured defect: left-aligned, Take over overlapped *Re-run from the
   * last message* — which sends a message — by 5.66 px at an identical x, and
   * the two arms replace each other on a poll. jsdom has no layout, so what is
   * pinned here is the structural fact the fix turns on: the two buttons sit on
   * opposite edges of their rows.
   */
  it('keeps Take over off the edge Re-run uses', async () => {
    await renderTask({ ...ELSEWHERE, status: 'blocked' })
    const takeOverButton = await screen.findByRole('button', { name: 'Take over' })
    expect(takeOverButton.parentElement?.className).toContain('justify-end')
  })

  /**
   * The other measured one: the peer reports a failure on a poll, so this line
   * appears with no gesture. Above the button it moved it by 7.83 px.
   */
  it('puts a failure reason below the control, never above it', async () => {
    await renderTask({
      ...ELSEWHERE,
      status: 'error',
      errorMessage: 'The ledger file was missing.'
    })
    const reason = await screen.findByText('The ledger file was missing.')
    const button = screen.getByRole('button', { name: 'Take over' })
    // `DOCUMENT_POSITION_FOLLOWING` — the reason comes after the button.
    expect(button.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  /**
   * Even with an ask sitting in this device's inbox for the same task id. That
   * combination cannot happen through sync — the rows do not travel — but the
   * page must not *depend* on that, because the banner it would otherwise show
   * points at a list whose controls answer a driver on another machine.
   */
  it('does not point at the Inbox for a task it does not hold', async () => {
    listInbox.mockResolvedValue(inbox([WAITING]))
    await renderTask({ ...ELSEWHERE, status: 'blocked' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take over' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Open the Inbox' })).toBeNull()
  })

  it('claims the task and leaves the second press to the user', async () => {
    // The claim is a real write, so the next read returns the claimed task —
    // modelled here, because the hook seeds the cache *and* re-reads, and a
    // mock that kept answering "elsewhere" would test the seed alone.
    takeOver.mockImplementation(async () => {
      const claimed: TaskDto = { ...BASE, status: 'blocked', runsHere: true }
      getTask.mockResolvedValue(claimed)
      return claimed
    })
    await renderTask({ ...ELSEWHERE, status: 'blocked' })
    const button = await screen.findByRole('button', { name: 'Take over' })
    await act(async () => {
      button.click()
    })

    // `force` is false: this is another *device*, and a device claim asks
    // nothing of a network, so there is never anything to confirm.
    expect(takeOver).toHaveBeenCalledWith('t1', false)
    // The claim alone — nothing was run.
    expect(runSend).not.toHaveBeenCalled()
    // And the page now shows what the task's own status makes possible.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Re-run from the last message/ })
      ).toBeTruthy()
    )
  })

  it('keeps the control and says why when the claim is refused', async () => {
    takeOver.mockRejectedValue(new Error('Error invoking remote method: Task not found'))
    await renderTask({ ...ELSEWHERE, status: 'blocked' })
    const button = await screen.findByRole('button', { name: 'Take over' })
    await act(async () => {
      button.click()
    })

    await waitFor(() => expect(screen.getByText(/Task not found/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Take over' })).toBeTruthy()
  })

  /**
   * A finished task keeps the claim of whichever device ran it — nothing clears
   * `executorDevice` on completion — so the banner has to be about what is
   * still possible rather than about who holds the row. There is nothing to
   * take over from a task that is over.
   */
  it.each(['completed', 'cancelled', 'archived'] as const)('says nothing when the work is %s', async (status) => {
    await renderTask({ ...ELSEWHERE, status })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull()
  })
})

describe('autonomous task attention', () => {
  it('offers the Inbox for a live agent approval even though the owner turn has not ended', async () => {
    listInbox.mockResolvedValue(inbox([WAITING]))
    await renderTask({ runtime: { state: 'running', reason: null, ownerTurns: 1, elapsedMs: 100,
      budget: { maxRounds: 20, maxMinutes: 60 } } })
    expect(screen.getByText('Waiting for your answer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open the Inbox' }))
    expect(useUIStore.getState().activeView).toBe('inbox')
    expect(screen.queryByRole('button', { name: 'Re-run from the last message' })).toBeNull()
    expect(runSend).not.toHaveBeenCalled()
  })

  it('uses checkpoint recovery rather than replay when an interrupted task has no Inbox rows', async () => {
    listInbox.mockResolvedValue(inbox([]))
    await renderTask({ runtime: { state: 'interrupted', reason: 'App closed', ownerTurns: 1, elapsedMs: 100,
      budget: { maxRounds: 20, maxMinutes: 60 } } })
    expect(screen.getByRole('button', { name: 'Resume task' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Re-run from the last message' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open the Inbox' })).toBeNull()
  })
})

it.each([
  ['script', 'Defined script steps'],
  ['human', 'You (via the Inbox)']
] as const)('identifies the %s assignee without claiming a model runs the task', async (kind, label) => {
  await renderTask({ assignee: { kind, agentId: null, name: null } })
  expect(screen.getByText(label)).toBeTruthy()
  expect(screen.queryByText('The local model')).toBeNull()
})

it('shows the exact time when a relative one is clicked, and goes back on a second click', async () => {
  await renderTask()
  const details = screen.getByRole('complementary', { name: 'Details' })
  const exact = BASE.updatedAt.toLocaleString()
  const updated = within(details).getAllByRole('button', { pressed: false })[0]
  expect(updated.textContent).not.toBe(exact)
  fireEvent.click(updated)
  expect(updated.textContent).toBe(exact)
  fireEvent.click(updated)
  expect(updated.textContent).not.toBe(exact)
})

it('keeps a long title on one line and puts the whole of it in the tooltip', async () => {
  const title = 'Reconcile '.repeat(30).trim()
  await renderTask({ title })
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading.className).toContain('truncate')
  expect(heading.getAttribute('title')).toBe(title)
})

it('opens the assigned agent’s page from Details', async () => {
  await renderTask()
  const details = screen.getByRole('complementary', { name: 'Details' })
  const agent = await within(details).findByRole('button', { name: 'Invoice Checker' })
  await act(async () => { agent.click() })
  expect(useUIStore.getState().activeView).toBe('external-agent')
  expect(useUIStore.getState().activeExternalAgentId).toBe('a1')
  expect(useUIStore.getState().sidebarTab).toBe('agents')
})

it('leaves an agent that is no longer listed as plain text', async () => {
  await renderTask({ assignee: { kind: 'agent', agentId: 'gone', name: 'Old Checker' } })
  const details = screen.getByRole('complementary', { name: 'Details' })
  await within(details).findByText('Old Checker')
  expect(within(details).queryByRole('button', { name: 'Old Checker' })).toBeNull()
})

it('opens a folder agent’s page on its local route', async () => {
  await renderTask({ assignee: { kind: 'agent', agentId: 'folder:m1', name: 'Ledger Folder' } })
  const details = screen.getByRole('complementary', { name: 'Details' })
  const agent = await within(details).findByRole('button', { name: 'Ledger Folder' })
  await act(async () => { agent.click() })
  expect(useUIStore.getState().activeView).toBe('local-agent')
  expect(useUIStore.getState().activeLocalAgentId).toBe('folder:m1')
})

it('sends a task whose job was deleted back to the Inbox, with no Job row', async () => {
  // `tasks.job_id` outlives its job; the job page would load for ever.
  getJob.mockRejectedValue(new Error('Job not found'))
  await renderTask({ parentTaskId: null })
  const back = await screen.findByRole('button', { name: 'Back to the Inbox' }, { timeout: 4000 })
  expect(screen.queryByRole('button', { name: /^Back to (the job|Nightly)/ })).toBeNull()
  const details = screen.getByRole('complementary', { name: 'Details' })
  expect(within(details).queryByText('Job')).toBeNull()
  await act(async () => { back.click() })
  expect(useUIStore.getState().activeView).toBe('inbox')
})

/**
 * A task that came from a file handover.
 *
 * The page's other rows describe a task the user created. These three describe
 * work that arrived from *somewhere else* — a brief dropped into a folder by an
 * agent, a script or a person — and the question they answer is the one no
 * other surface can: who asked, how far it has got, and where the files are.
 * They are rows in the panel that already exists, never a banner
 * (`ux_rules.md` §2), and an ordinary task must grow none of them.
 */
const HANDOVER: HandoverDto = {
  id: 'hov_1',
  agentId: 'folder:m1',
  folderPath: '/Users/dev/projects/uploader',
  handoverId: '20260917-2000-add-retry',
  taskId: 't1',
  originAgentId: 'a1',
  originChatId: 'c9',
  originTaskId: null,
  depth: 1,
  groupId: null,
  execution: 'ask',
  state: 'running',
  refusalReason: null,
  warning: null,
  reportStatus: 'in_progress',
  runId: 'run_1',
  wokeAt: null,
  briefMissingAt: null,
  lastScannedAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now()
}

/** The value of the Details row with this label, or null when there is no such row. */
function detail(label: string): string | null {
  const dt = [...document.querySelectorAll('dt')].find((node) => node.textContent === label)
  return dt?.parentElement?.querySelector('dd')?.textContent ?? null
}

describe('a task that came from a handover', () => {
  it('adds no handover rows to an ordinary task', async () => {
    await renderTask()
    await waitFor(() => expect(forTask).toHaveBeenCalledWith('t1'))
    expect(detail('Requested by')).toBeNull()
    expect(detail('Handover')).toBeNull()
    expect(detail('Folder')).toBeNull()
  })

  it('names the agent that asked, where the work is, and the folder it is in', async () => {
    forTask.mockResolvedValue(HANDOVER)
    await renderTask()
    // The name alone under a label that says what it is: "Handover from
    // Planner" sat directly above a row labelled Handover (§7).
    await waitFor(() => expect(detail('Requested by')).toBe('Invoice Checker'))
    expect(detail('Handover')).toBe('Running')
    // One line, the handover id intact, the whole path on hover: `break-all`
    // put it on five lines and made the row beside it as tall (§1).
    expect(detail('Folder')).toBe('20260917-2000-add-retry')
    const path = [...document.querySelectorAll('dd span')].find((node) =>
      node.getAttribute('title')?.includes('.cinna/handovers')
    )
    expect(path?.getAttribute('title')).toBe(
      '/Users/dev/projects/uploader/.cinna/handovers/20260917-2000-add-retry'
    )
  })

  it('opens the requester’s page from the row that names it', async () => {
    /*
      The Assignee row above it is a link to the same kind of page, and a
      requester rendered as prose is a control the user never finds (§11).
      Mutation: render `originName` as text and there is no button to press.
    */
    forTask.mockResolvedValue(HANDOVER)
    await renderTask()
    await waitFor(() => expect(detail('Requested by')).toBe('Invoice Checker'))
    const dt = [...document.querySelectorAll('dt')].find(
      (node) => node.textContent === 'Requested by'
    )
    const button = dt?.parentElement?.querySelector('dd button')
    expect(button?.textContent).toBe('Invoice Checker')
    // The Assignee row's colour, not the muted grey of the labels beside it.
    expect(button?.className).toContain('--color-accent')
  })

  it('says a brief nobody signed came from outside the app', async () => {
    forTask.mockResolvedValue({ ...HANDOVER, originAgentId: null })
    await renderTask()
    await waitFor(() => expect(detail('Requested by')).toBe('Outside the app'))
    // Plain text: there is no page for a person with a text editor.
    expect(screen.queryByRole('button', { name: 'Outside the app' })).toBeNull()
  })

  it('stops naming a folder the requester has deleted', async () => {
    /*
      §9: a row that prints `.cinna/handovers/<id>` is asserting that directory
      is there. Withdrawing a handover is deleting the brief, and the row went
      on naming the folder afterwards. Mutation: drop the `briefMissingAt`
      guard and the Folder row comes back over a directory that is gone.
    */
    forTask.mockResolvedValue({ ...HANDOVER, state: 'skipped', briefMissingAt: Date.now() })
    await renderTask()
    await waitFor(() => expect(detail('Handover')).toBe('Withdrawn'))
    expect(detail('Folder')).toBeNull()
    expect(detail('Note')).toBe(
      'The requester removed the brief, so the handover was withdrawn'
    )
  })

  it('keeps a plain Skip plain', async () => {
    // The user answered Skip in the Inbox: nothing was withdrawn, and the
    // brief is still on disk.
    forTask.mockResolvedValue({ ...HANDOVER, state: 'skipped' })
    await renderTask()
    await waitFor(() => expect(detail('Handover')).toBe('Skipped'))
    expect(detail('Folder')).toBe('20260917-2000-add-retry')
    expect(detail('Note')).toBeNull()
  })

  it('never says "outside the app" while it is still finding out who asked', async () => {
    /*
      The trap the assignee row already documents, from the other side: an
      origin that *is* named must not read as anonymous for the round trip it
      takes to resolve the name. Mutation: drop the `agentsPending` guard and
      the row renders "Outside the app" first and the agent's
      name a moment later — a retraction on the one row that says who is
      accountable for the work.
    */
    let release: (value: unknown) => void = () => {}
    const held = new Promise((resolve) => {
      release = resolve
    })
    const api = (window as unknown as { api: { agents: { list: () => Promise<unknown> } } }).api
    const listed = api.agents.list
    api.agents.list = async () => {
      await held
      return listed()
    }
    try {
      forTask.mockResolvedValue(HANDOVER)
      await renderTask()
      await waitFor(() => expect(detail('Handover')).toBe('Running'))
      expect(detail('Requested by')).not.toBe('Outside the app')
      await act(async () => {
        release(undefined)
        await held
      })
      await waitFor(() => expect(detail('Requested by')).toBe('Invoice Checker'))
    } finally {
      api.agents.list = listed
    }
  })

  it('says a handover being run by somebody else is running outside the app', async () => {
    // §3.9: a terminal session claimed the brief by writing `in_progress`
    // before Cinna could start one. Nothing is wrong, and nothing is ours.
    forTask.mockResolvedValue({ ...HANDOVER, state: 'waiting_external' })
    await renderTask()
    // Short enough for one line of a 13rem column, whatever the state (§1).
    await waitFor(() => expect(detail('Handover')).toBe('Outside the app'))
  })

  it('gives a refusal its reason in the same row', async () => {
    forTask.mockResolvedValue({
      ...HANDOVER,
      state: 'refused',
      refusalReason: 'depth_exceeded'
    })
    await renderTask()
    // "Refused" alone sends the user looking for a cause this page would then
    // not show (§6).
    await waitFor(() => expect(detail('Handover')).toBe('Refused: too deep'))
  })

  it('reports a warning as a note, last, in the user’s words', async () => {
    forTask.mockResolvedValue({ ...HANDOVER, state: 'done', warning: 'brief_edited' })
    await renderTask()
    await waitFor(() =>
      expect(detail('Note')).toBe(
        'The brief was edited after it was picked up; the task keeps the original'
      )
    )
    // Last in the panel: a note about work that already happened may lengthen
    // the list, never move a row above it (§1).
    const labels = [...document.querySelectorAll('dt')].map((node) => node.textContent)
    expect(labels[labels.length - 1]).toBe('Note')
  })

  it('spells out a refused automatic run, reason and all', async () => {
    forTask.mockResolvedValue({ ...HANDOVER, warning: 'auto_not_allowed:tracked' })
    await renderTask()
    await waitFor(() =>
      expect(detail('Note')).toBe(
        'Automatic run was not allowed: .cinna/handovers is tracked by git'
      )
    )
  })

  it('shows no note when there is nothing to warn about', async () => {
    forTask.mockResolvedValue(HANDOVER)
    await renderTask()
    await waitFor(() => expect(detail('Handover')).toBe('Running'))
    expect(detail('Note')).toBeNull()
  })
})

describe('delegated work links', () => {
  it('lets the user retry a failed requester lookup without losing the relation', async () => {
    delegationLinks.mockResolvedValue({ from: { id: 'from', taskId: 't1', originTaskId: 'root-task', targetKind: 'kit', state: 'running' } as DelegationDto, to: [] })
    let readable = false
    getTask.mockImplementation(async (taskId) => {
      if (taskId === 'root-task') {
        if (!readable) throw new Error('Temporary read failure')
        return { ...BASE, id: 'root-task', title: 'Plan the audit' }
      }
      return BASE
    })
    client.setQueryDefaults(['task', 'root-task'], { retryDelay: 0 })
    render(createElement(TaskView), { wrapper })
    const details = await screen.findByRole('complementary', { name: 'Details' })
    expect(await within(details).findByText('Could not read the requester task.')).not.toBeNull()
    expect(within(details).getByText('Delegated from')).not.toBeNull()
    expect(within(details).queryByText('Requester task unavailable')).toBeNull()
    readable = true
    fireEvent.click(within(details).getByRole('button', { name: 'Try again' }))
    expect(await within(details).findByRole('button', { name: 'Plan the audit' })).not.toBeNull()
    expect(within(details).queryByText('Could not read the requester task.')).toBeNull()
  })

  it('explains an uncertain follow-up without exposing its internal warning or reply identifier', async () => {
    delegationLinks.mockResolvedValue({ from: { id: 'from', taskId: 't1', targetKind: 'kit', state: 'running', warning: 'reply_uncertain:opaque-reply-id:Error: Interrupted admission' } as DelegationDto, to: [] })
    await renderTask()
    await waitFor(() => expect(detail('Note')).toContain('Check the executor’s conversation before sending it again.'))
    expect(detail('Note')).not.toContain('reply_uncertain')
    expect(detail('Note')).not.toContain('opaque-reply-id')
  })

  it('explains a delegation that needs review under its Delegated-to row, on one line', async () => {
    const to = { id: 'to', taskId: 'cloud-task', title: 'Audit remotely', targetKind: 'cloud', targetAgentId: 'cloud-agent', state: 'uncertain', waitingOnUser: false, warning: null, refusalReason: null, dispatchError: 'The previous dispatch was interrupted. Check the remote task before retrying.' } as DelegationDto
    delegationLinks.mockImplementation(async (taskId) => taskId === 't1' ? { from: null, to: [to] } : { from: null, to: [] })
    render(createElement(TaskView), { wrapper })
    const details = await screen.findByRole('complementary', { name: 'Details' })
    const note = await within(details).findByText('The previous dispatch was interrupted. Check the remote task before retrying.')
    expect(note.className).toContain('truncate')
    expect(note.getAttribute('title')).toBe(note.textContent)
  })

  it('shows requester and executor task links with cloud user attention separately from the task tree', async () => {
    const from = { id: 'from', taskId: 't1', originTaskId: 'root-task', originAgentId: 'a1', targetKind: 'kit', targetAgentId: 'folder:m1', state: 'running', waitingOnUser: false } as DelegationDto
    const to = { id: 'to', taskId: 'cloud-task', title: 'Audit remotely', targetKind: 'cloud', targetAgentId: 'cloud-agent', state: 'waiting_user', waitingOnUser: true } as DelegationDto
    delegationLinks.mockImplementation(async (taskId) => taskId === 't1' ? { from, to: [to] } : { from: null, to: [] })
    getTask.mockImplementation(async (taskId) => taskId === 'root-task' ? { ...BASE, id: 'root-task', title: 'Plan the audit' } : { ...BASE, status: 'in_progress' })
    render(createElement(TaskView), { wrapper })
    const details = await screen.findByRole('complementary', { name: 'Details' })
    const source = await within(details).findByRole('button', { name: 'Plan the audit' })
    expect(within(details).getByText('Delegated from')).not.toBeNull()
    expect(within(details).getByText('Delegated to')).not.toBeNull()
    // The separator lives in its own span so a wrap keeps it with the state.
    expect(within(details).getByText('· Waiting on you').parentElement?.textContent).toBe('Cloud agent · Waiting on you')
    fireEvent.click(source)
    expect(useUIStore.getState().activeTaskId).toBe('root-task')
  })

  it('opens the delegated executor task without changing its parent hierarchy', async () => {
    delegationLinks.mockResolvedValue({ from: null, to: [{ id: 'to', taskId: 'worker-task', title: 'Review the patch', targetKind: 'kit', targetAgentId: 'folder:m1', state: 'done', waitingOnUser: false } as DelegationDto] })
    await renderTask({ status: 'completed', parentTaskId: null })
    const details = screen.getByRole('complementary', { name: 'Details' })
    fireEvent.click(await within(details).findByRole('button', { name: 'Review the patch' }))
    expect(useUIStore.getState().activeTaskId).toBe('worker-task')
  })
})
