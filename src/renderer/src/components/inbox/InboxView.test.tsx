import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskAnswerPayload, InboxAnswerResult, InboxEntry } from '../../../../shared/inbox'

/**
 * The inbox, driven — the real ask components, clicked.
 *
 * Which components those are is `InboxView.blocks.test.tsx`; what they do once
 * a user presses one is here. The behaviour worth the file is that a row the
 * user has **acted on** does not vanish: answering removes it from the next
 * read of the list, and letting that removal happen would pull the outcome out
 * from under the person still reading it (`ux_rules.md` §1).
 */

const listMock = vi.fn<() => Promise<InboxEntry[]>>()
const answerMock = vi.fn<(data: AskAnswerPayload) => Promise<InboxAnswerResult>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  inbox: { list: () => listMock(), answer: (data: AskAnswerPayload) => answerMock(data) },
  agents: {
    list: async () => [{ id: 'a1', name: 'Invoice Checker' }],
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {}
  }
}

const { InboxView } = await import('./InboxView')
const { useUIStore } = await import('../../stores/ui.store')
const { useChatStore } = await import('../../stores/chat.store')

const PERMISSION: InboxEntry = {
  requestId: 'per_1',
  source: 'local',
  taskId: 't1',
  taskTitle: 'Nightly check',
  chatId: 'c1',
  agentId: 'a1',
  request: { kind: 'permission', action: 'bash', resources: ['rm -rf build'] },
  resume: 'reply',
  createdAt: new Date('2026-09-11T10:00:00Z')
}

const QUESTION: InboxEntry = {
  requestId: 'que_1',
  source: 'local',
  taskId: 't2',
  taskTitle: 'Weekly digest',
  chatId: 'c2',
  agentId: 'a1',
  request: {
    kind: 'question',
    questions: [{ question: 'Which invoice?', multiSelect: false, options: [{ label: 'The first' }] }]
  },
  resume: 'reply',
  createdAt: new Date('2026-09-11T09:00:00Z')
}

let client: QueryClient

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

/** The five-second poll, without waiting five seconds for it. */
async function poll(): Promise<void> {
  await act(async () => {
    await client.refetchQueries({ queryKey: ['inbox'] })
  })
}

function renderInbox(): ReturnType<typeof render> {
  return render(createElement(InboxView), { wrapper })
}

/** The task title of each row, in the order they are rendered. */
function rowTitles(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('article')].map(
    (row) => row.querySelector('.font-medium')?.textContent ?? null
  )
}

beforeEach(() => {
  // `retryDelay`, not `retry`: `useInboxList` sets `retry: 1` itself and a
  // hook's own option beats the client default, so the retry happens either
  // way — this only stops the test paying its second-long backoff.
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  listMock.mockReset()
  answerMock.mockReset()
  useUIStore.setState({ activeView: 'inbox', sidebarTab: 'jobs' } as never)
  useChatStore.setState({ activeChatId: null } as never)
})

describe('InboxView', () => {
  it('names the task and the agent on the row', async () => {
    listMock.mockResolvedValue([PERMISSION])
    renderInbox()
    expect(await screen.findByText('Nightly check')).toBeTruthy()
    expect(await screen.findByText(/Invoice Checker/)).toBeTruthy()
  })

  it('never says "An agent" while it is still finding out who the agent is', async () => {
    // Mutation: fall back to 'An agent' whenever the name does not resolve and
    // this fails — the phrase reserved for a *deleted* agent lands on every row
    // for the first moment of every load, and stops meaning "gone".
    listMock.mockResolvedValue([PERMISSION])
    let settleAgents: (rows: { id: string; name: string }[]) => void = () => {}
    const agents = new Promise<{ id: string; name: string }[]>((resolve) => {
      settleAgents = resolve
    })
    ;(window as unknown as { api: { agents: Record<string, unknown> } }).api.agents.list = () =>
      agents
    renderInbox()
    await screen.findByText('Nightly check')
    expect(screen.queryByText(/An agent/)).toBeNull()

    await act(async () => {
      settleAgents([{ id: 'a1', name: 'Invoice Checker' }])
      await agents
    })
    expect(await screen.findByText(/Invoice Checker/)).toBeTruthy()
  })

  it('says "An agent" for an agent that is genuinely gone', async () => {
    listMock.mockResolvedValue([{ ...PERMISSION, agentId: 'deleted-agent' }])
    renderInbox()
    expect(await screen.findByText(/An agent/)).toBeTruthy()
  })

  it('sends the reply the user pressed and settles the row', async () => {
    listMock.mockResolvedValue([PERMISSION])
    answerMock.mockResolvedValue({ ok: true, remembered: true })
    renderInbox()
    fireEvent.click(await screen.findByText('Always allow'))
    await waitFor(() =>
      expect(answerMock).toHaveBeenCalledWith({ requestId: 'per_1', reply: 'always' })
    )
    // The block's own record of what happened — proof the outcome reached the
    // component rather than being reported by the row around it.
    expect(await screen.findByText('Allowed, and remembered for this agent.')).toBeTruthy()
  })

  it('keeps a row the user answered even once the list stops returning it', async () => {
    // Mutation: drop `onActed(entry)` from `deliver` and this fails — the
    // refetch that follows the answer empties the list and the card the user is
    // still reading is replaced by the empty state (`ux_rules.md` §1).
    listMock.mockResolvedValueOnce([PERMISSION]).mockResolvedValue([])
    answerMock.mockResolvedValue({ ok: true })
    renderInbox()
    fireEvent.click(await screen.findByText('Allow once'))
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('Allowed once.')).toBeTruthy())
    expect(screen.getByText('Nightly check')).toBeTruthy()
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull()
  })

  it('preserves a remote answer draft through delivery failure and retries it', async () => {
    listMock.mockResolvedValue([{ ...QUESTION, source: 'remote', chatId: null }])
    answerMock.mockResolvedValueOnce({ ok: false, code: 'unavailable', reason: 'The service is offline.' })
      .mockResolvedValueOnce({ ok: true })
    render(createElement(InboxView), { wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Answer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Other (enter custom answer)' }))
    const input = screen.getByPlaceholderText('Type your answer…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Keep this detailed answer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The service is offline.')
    expect(screen.getByRole('dialog', { name: 'Question' })).toBeTruthy()
    expect(input.value).toBe('Keep this detailed answer')
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(answerMock.mock.calls).toEqual([
      [{ requestId: 'que_1', answers: [['Keep this detailed answer']] }],
      [{ requestId: 'que_1', answers: [['Keep this detailed answer']] }]
    ])
    expect(screen.getByText('Answered: Keep this detailed answer.')).toBeTruthy()
  })

  it('answers a question by request id and stops offering the control', async () => {
    // Mutation: restore `liveRequestId={entry.requestId}` unconditionally and
    // this fails on the last line — the row keeps an Answer button whose only
    // remaining outcome is "already answered".
    listMock.mockResolvedValue([QUESTION])
    answerMock.mockResolvedValue({ ok: true })
    renderInbox()
    fireEvent.click(await screen.findByRole('button', { name: /^Answer$/ }))
    fireEvent.click(await screen.findByText('The first'))
    fireEvent.click(screen.getByRole('button', { name: /Send answer/ }))
    await waitFor(() =>
      expect(answerMock).toHaveBeenCalledWith({
        requestId: 'que_1',
        answers: [['The first']]
      })
    )
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Answer$/ })).toBeNull()
    )
    // Mutation: drop the `decision` prop and this fails — the row greys out
    // saying nothing about what was chosen, and the only way to find out is the
    // trip to the transcript the inbox exists to save. The sentence is the
    // runner's own, from `describeQuestionAnswers`, so it is the same one the
    // transcript shows for this ask one reload later.
    expect(screen.getByText('Answered: The first.')).toBeTruthy()
    // The button being gone is also what a vanished card looks like. Retention
    // for questions has its own way to break, so say the row is still there.
    expect(screen.getByText('Weekly digest')).toBeTruthy()
  })

  it('settles a row whose ask died, rather than leaving three buttons that cannot work', async () => {
    // An entry can expire between the list and the click. The refusal is a
    // sentence the user has to read, so the row stays and shows it — but the
    // ask is gone, and a card still amber with Allow / Always / Deny under
    // "no longer waiting" is offering a decision nobody can make.
    //
    // Mutation: drop `SETTLED_REFUSALS` and throw on every refusal, and the
    // last two lines fail — the block keeps its live look and its controls.
    listMock.mockResolvedValueOnce([PERMISSION]).mockResolvedValue([])
    answerMock.mockResolvedValue({
      ok: false,
      reason: 'This request is no longer waiting for an answer.',
      code: 'no_longer_waiting'
    })
    renderInbox()
    fireEvent.click(await screen.findByText('Allow once'))
    expect(
      await screen.findByText('This request is no longer waiting for an answer.')
    ).toBeTruthy()
    expect(screen.getByText('Nightly check')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Allow once')).toBeNull())
    expect(screen.queryByText('Deny')).toBeNull()
  })

  it('keeps the controls when the answer itself was the problem', async () => {
    // The other half of the branch: `malformed` is this row's own fault and
    // retrying is the right response, so the reason lands beside the control
    // that produced it and the control stays (`ux_rules.md` §6).
    listMock.mockResolvedValue([PERMISSION])
    answerMock.mockResolvedValue({
      ok: false,
      reason: 'Malformed answer',
      code: 'malformed'
    })
    renderInbox()
    fireEvent.click(await screen.findByText('Allow once'))
    expect(await screen.findByText('Malformed answer')).toBeTruthy()
    expect(screen.getByText('Allow once')).toBeTruthy()
  })

  it('builds the list newest first', async () => {
    listMock.mockResolvedValue([QUESTION, PERMISSION])
    const { container } = renderInbox()
    await screen.findByText('Nightly check')
    expect(rowTitles(container)).toEqual(['Nightly check', 'Weekly digest'])
  })

  it('appends an ask that arrives while the view is open, below the rows already there', async () => {
    // Mutation: re-sort `entries` newest-first on every read and this fails —
    // the arriving ask takes the top and pushes the row whose Deny the user is
    // reaching for down a whole card (`ux_rules.md` §1).
    const ARRIVED: InboxEntry = {
      ...PERMISSION,
      requestId: 'per_2',
      taskId: 't3',
      taskTitle: 'Just arrived',
      createdAt: new Date('2026-09-11T11:00:00Z')
    }
    listMock.mockResolvedValueOnce([PERMISSION]).mockResolvedValue([ARRIVED, PERMISSION])
    const { container } = renderInbox()
    await screen.findByText('Nightly check')
    await poll()
    await screen.findByText('Just arrived')
    expect(rowTitles(container)).toEqual(['Nightly check', 'Just arrived'])
  })

  it('says the inbox could not be read rather than that nothing is waiting', async () => {
    // Mutation: drop the `isError` branch and this fails on the first line —
    // a failed read renders as the empty state, which tells someone whose agent
    // is parked that nothing wants them (`ux_rules.md` §6).
    listMock.mockRejectedValue(new Error('database is locked'))
    renderInbox()
    expect(await screen.findByText('The inbox could not be read.')).toBeTruthy()
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull()
    listMock.mockResolvedValue([PERMISSION])
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nightly check')).toBeTruthy()
  })

  it('keeps the rows it has when a refresh fails, and says so under them', async () => {
    listMock.mockResolvedValueOnce([PERMISSION]).mockRejectedValue(new Error('nope'))
    const { container } = renderInbox()
    await screen.findByText('Nightly check')
    await poll()
    expect(
      await screen.findByText('Showing the last read — the inbox could not be refreshed.')
    ).toBeTruthy()
    expect(rowTitles(container)).toEqual(['Nightly check'])
  })

  it('opens the task an ask belongs to, which is the only way back to the work', async () => {
    // The step-5 UX review removed the link to the conversation: a parked ask
    // is a turn that has not resolved, so the transcript holds the prompt and
    // nothing else. The task page is what replaced it, and this row is where it
    // is reached from.
    listMock.mockResolvedValue([PERMISSION])
    renderInbox()
    fireEvent.click(await screen.findByRole('button', { name: 'Open the task' }))
    expect(useUIStore.getState().activeView).toBe('task')
    expect(useUIStore.getState().activeTaskId).toBe('t1')
  })

  it('says nothing is waiting when nothing is', async () => {
    listMock.mockResolvedValue([])
    renderInbox()
    expect(await screen.findByText('Nothing is waiting on you.')).toBeTruthy()
  })
})
