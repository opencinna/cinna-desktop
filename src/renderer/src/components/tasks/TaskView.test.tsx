import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const takeOver = vi.fn<(taskId: string, force?: boolean) => Promise<TaskDto>>()
const remoteLive = vi.fn<(taskId: string) => Promise<boolean | null>>()
const runSend = vi.fn()
const startTask = vi.fn()
const openExternal = vi.fn<(url: string) => Promise<{ success: boolean; error?: string }>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  tasks: {
    list: async () => [],
    children: async () => ({ tasks: [], refreshed: true }),
    start: (taskId: string, target: unknown) => startTask(taskId, target),
    get: () => getTask(),
    setStatus: (taskId: string, status: TaskStatus) => setStatus(taskId, status),
    takeOver: (taskId: string, force?: boolean) => takeOver(taskId, force),
    remoteLive: (taskId: string) => remoteLive(taskId)
  },
  inbox: { list: () => listInbox() },
  agents: {
    list: async () => [{ id: 'a1', name: 'Invoice Checker', enabled: true }],
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
  listInbox.mockResolvedValue([])
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
      listInbox.mockResolvedValue([{ ...WAITING, source: 'remote', chatId: null }])
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
    listInbox.mockResolvedValue([WAITING])
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
