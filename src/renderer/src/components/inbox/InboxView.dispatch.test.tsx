import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  InboxSnapshot,
  TaskDispatchGateAction,
  TaskDispatchGateItem,
  TaskDispatchGateResult,
  TaskDispatchPausedItem
} from '../../../../shared/inbox'
import type { TaskDispatchUpdateResult } from '../../../../shared/taskDispatch'

/**
 * The task dispatcher's two Inbox cards: the approval of a task changed
 * outside Cinna (Approve and run / Skip), and a paused queue (Resume). Like an
 * answered ask, a card the user acted on stays with what it settled as; a
 * failure keeps the card and its buttons and says why beside them.
 */

const listMock = vi.fn<() => Promise<InboxSnapshot>>()
const answerGate = vi.fn<(gateId: string, action: TaskDispatchGateAction) => Promise<TaskDispatchGateResult>>()
const resume = vi.fn<(agentId: string) => Promise<TaskDispatchUpdateResult>>()
const reveal = vi.fn<(input: { agentId: string; path: string }) => Promise<{ success: true } | { success: false; error: string }>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  inbox: {
    list: () => listMock(),
    answer: vi.fn(),
    answerDispatchGate: (gateId: string, action: TaskDispatchGateAction) => answerGate(gateId, action)
  },
  taskDispatch: { resume: (agentId: string) => resume(agentId), onChanged: () => () => {} },
  agentFiles: { reveal: (input: { agentId: string; path: string }) => reveal(input) },
  tasks: { list: async () => [] },
  agents: {
    list: async () => [{ id: 'folder:w', name: 'Writer' }],
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {}
  }
}

const { InboxView } = await import('./InboxView')
const { useUIStore } = await import('../../stores/ui.store')

const GATE: TaskDispatchGateItem = {
  kind: 'dispatch_gate',
  gateId: 'g1',
  taskId: 't9',
  taskTitle: 'Fix the login',
  agentId: 'folder:w',
  filePath: '/w/.cinna/tasks/fix-login.md',
  body: '# Fix the login\n\nThe session cookie expires too early.',
  createdAt: new Date('2026-10-03T10:00:00Z')
}

const PAUSED: TaskDispatchPausedItem = {
  kind: 'dispatch_paused',
  agentId: 'folder:w',
  reason: 'error',
  taskId: 't8',
  taskTitle: 'Ship the release',
  note: 'The agent could not be started.',
  pausedAt: new Date('2026-10-03T09:00:00Z')
}

function snapshot(dispatch: InboxSnapshot['dispatch']): InboxSnapshot {
  return { entries: [], unreadable: [], dispatch }
}

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

async function poll(): Promise<void> {
  await act(async () => { await client.refetchQueries({ queryKey: ['inbox'] }) })
}

function gateCard(): HTMLElement {
  return screen.getByRole('article', { name: 'Run a task changed outside Cinna?' })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  listMock.mockReset()
  answerGate.mockReset()
  resume.mockReset()
  reveal.mockReset().mockResolvedValue({ success: true })
  useUIStore.setState({ activeView: 'inbox', activeTaskId: null, revealInboxGateId: null } as never)
})

describe('the outside-content approval', () => {
  it('shows the task, its agent, its file and the body as it will be sent, and counts it', async () => {
    listMock.mockResolvedValue(snapshot([GATE]))
    render(createElement(InboxView), { wrapper })
    const card = await screen.findByRole('article', { name: 'Run a task changed outside Cinna?' })
    expect(within(card).getByText('Fix the login')).toBeTruthy()
    await waitFor(() => expect(within(card).getByText(/^Writer · /)).toBeTruthy())
    // The file from the agent's folder on, the whole path in the tooltip.
    const file = card.querySelector('[data-gate-file]') as HTMLElement
    expect(file.textContent).toBe('.cinna/tasks/fix-login.md')
    expect(file.title).toBe(GATE.filePath)
    expect(within(card).getByLabelText('What the agent will receive').textContent).toBe(GATE.body)
    expect(screen.getByText('1 waiting')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Reveal' }))
    expect(reveal).toHaveBeenCalledWith({ agentId: 'folder:w', path: GATE.filePath })
    fireEvent.click(within(card).getByRole('button', { name: 'Open the task' }))
    expect(useUIStore.getState().activeTaskId).toBe('t9')
  })

  it('approves and runs, then keeps the card with what it settled as after the next read drops it', async () => {
    listMock.mockResolvedValue(snapshot([GATE]))
    answerGate.mockResolvedValue({ ok: true, started: { taskId: 't9', chatId: 'c1' } })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: 'Run a task changed outside Cinna?' })
    await act(async () => { fireEvent.click(within(gateCard()).getByRole('button', { name: 'Approve and run' })) })
    expect(answerGate).toHaveBeenCalledWith('g1', 'approve')
    listMock.mockResolvedValue(snapshot([]))
    await poll()
    expect(within(gateCard()).getByRole('status').textContent).toBe('Approved. The task is running.')
    expect(within(gateCard()).queryByRole('button', { name: 'Approve and run' })).toBeNull()
  })

  it.each([
    [{ reason: 'folder_busy', mode: 'one' }, 'Approved. It starts when the folder is free.'],
    [{ reason: 'folder_busy', mode: 'manual' }, 'Approved. Use Run next when the folder is free.'],
    // Mutation: fold agent_busy, live_turn and slot back into folder_busy → the folder sentence for each.
    [{ reason: 'agent_busy', mode: 'up_to', maxRuns: 3 }, 'Approved. It starts when one of Writer’s 3 runs finishes.'],
    [{ reason: 'agent_busy', mode: 'one', maxRuns: null }, 'Approved. It starts when Writer’s current run finishes.'],
    [{ reason: 'agent_busy', mode: 'manual', maxRuns: null }, 'Approved. Use Run next when Writer’s current run finishes.'],
    [{ reason: 'live_turn', mode: 'one' }, 'Approved. It starts when the conversation running there finishes.'],
    [{ reason: 'live_turn', mode: 'manual' }, 'Approved. Use Run next when the conversation running there finishes.'],
    [{ reason: 'slot', mode: 'one' }, 'Approved. It starts when a task runner slot is free.'],
    [{ reason: 'slot', mode: 'up_to', maxRuns: 2 }, 'Approved. It starts when a task runner slot is free.'],
    [{ reason: 'not_eligible', mode: 'one' }, 'Approved. It is not ready to run yet.'],
    [{ reason: 'not_eligible', mode: 'manual' }, 'Approved. It is not ready to run yet.']
  ] as const)('says when an approved task it could not start will run (%o)', async (deferral, text) => {
    listMock.mockResolvedValue(snapshot([GATE]))
    answerGate.mockResolvedValue({ ok: true, started: null, ...deferral })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: 'Run a task changed outside Cinna?' })
    await act(async () => { fireEvent.click(within(gateCard()).getByRole('button', { name: 'Approve and run' })) })
    expect(within(gateCard()).getByRole('status').textContent).toBe(text)
  })

  it('skips', async () => {
    listMock.mockResolvedValue(snapshot([GATE]))
    answerGate.mockResolvedValue({ ok: true, started: null })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: 'Run a task changed outside Cinna?' })
    await act(async () => { fireEvent.click(within(gateCard()).getByRole('button', { name: 'Skip' })) })
    expect(answerGate).toHaveBeenCalledWith('g1', 'skip')
    expect(within(gateCard()).getByRole('status').textContent).toMatch(/^Skipped\./)
  })

  it('keeps the card and its buttons when saving fails, with the reason beside them', async () => {
    listMock.mockResolvedValue(snapshot([GATE]))
    answerGate.mockResolvedValueOnce({ ok: false, code: 'unavailable', reason: 'The approval could not be saved. Try again.' })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: 'Run a task changed outside Cinna?' })
    await act(async () => { fireEvent.click(within(gateCard()).getByRole('button', { name: 'Approve and run' })) })
    expect(within(gateCard()).getByRole('alert').textContent).toBe('The approval could not be saved. Try again.')
    expect(within(gateCard()).getByRole('button', { name: 'Approve and run' })).toBeTruthy()
    expect(within(gateCard()).getByRole('button', { name: 'Skip' })).toBeTruthy()

    // A rejected call is unwrapped, and the card stays too.
    answerGate.mockRejectedValueOnce(new Error("Error invoking remote method 'inbox:dispatch-gate': Error: Not activated"))
    await act(async () => { fireEvent.click(within(gateCard()).getByRole('button', { name: 'Skip' })) })
    expect(within(gateCard()).getByRole('alert').textContent).toBe('Not activated')
    expect(within(gateCard()).getByRole('button', { name: 'Skip' })).toBeTruthy()
  })

  it('settles with main’s sentence when the approval is gone', async () => {
    listMock.mockResolvedValue(snapshot([GATE]))
    answerGate.mockResolvedValue({ ok: false, code: 'changed', reason: 'The task file changed since this was asked.' })
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: 'Run a task changed outside Cinna?' })
    await act(async () => { fireEvent.click(within(gateCard()).getByRole('button', { name: 'Approve and run' })) })
    expect(within(gateCard()).getByRole('status').textContent).toBe('The task file changed since this was asked.')
    expect(within(gateCard()).queryByRole('button', { name: 'Skip' })).toBeNull()
  })

  it('marks the card Run next opened it for, once', async () => {
    listMock.mockResolvedValue(snapshot([GATE]))
    useUIStore.setState({ revealInboxGateId: 'g1' } as never)
    render(createElement(InboxView), { wrapper })
    const card = await screen.findByRole('article', { name: 'Run a task changed outside Cinna?' })
    await waitFor(() => expect(card.className).toContain('ring-2'))
    expect(document.activeElement).toBe(card)
    expect(useUIStore.getState().revealInboxGateId).toBeNull()
  })
})

describe('Run next’s request to mark an approval', () => {
  it('lets the request go once a settled read does not hold that card', async () => {
    listMock.mockResolvedValue(snapshot([PAUSED]))
    useUIStore.setState({ revealInboxGateId: 'gone' } as never)
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: /queue is paused$/ })
    await waitFor(() => expect(useUIStore.getState().revealInboxGateId).toBeNull())

    // A card that arrives later is not marked by the stale request.
    listMock.mockResolvedValue(snapshot([{ ...GATE, gateId: 'gone' }, PAUSED]))
    await poll()
    const card = await screen.findByRole('article', { name: 'Run a task changed outside Cinna?' })
    expect(card.className).not.toContain('ring-2')
  })

  it('keeps the request while the read is still in flight', async () => {
    let release: (snapshot: InboxSnapshot) => void = () => {}
    listMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    useUIStore.setState({ revealInboxGateId: 'g1' } as never)
    render(createElement(InboxView), { wrapper })
    await waitFor(() => expect(listMock).toHaveBeenCalled())
    expect(useUIStore.getState().revealInboxGateId).toBe('g1')
    await act(async () => { release(snapshot([GATE])) })
    await waitFor(() => expect(gateCard().className).toContain('ring-2'))
  })
})

describe('a paused queue', () => {
  it('names the queue and the task, and resumes it', async () => {
    listMock.mockResolvedValue(snapshot([PAUSED]))
    resume.mockResolvedValue({ ok: true, state: { agentId: 'folder:w', mode: 'one', maxRuns: null, paused: null, running: [], next: null, waiting: null } })
    render(createElement(InboxView), { wrapper })
    const card = await screen.findByRole('article', { name: /queue is paused$/ })
    await waitFor(() => expect(card.getAttribute('aria-label')).toBe('Writer’s queue is paused'))
    expect(within(card).getByText('Ship the release failed')).toBeTruthy()
    expect(within(card).getByText('The agent could not be started.')).toBeTruthy()
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Resume' })) })
    expect(resume).toHaveBeenCalledWith('folder:w')
    listMock.mockResolvedValue(snapshot([]))
    await poll()
    const settled = screen.getByRole('article', { name: 'Writer’s queue is paused' })
    expect(within(settled).getByRole('status').textContent).toMatch(/^Resumed\./)
  })

  it('keeps Resume and says why when it is refused', async () => {
    listMock.mockResolvedValue(snapshot([PAUSED]))
    resume.mockResolvedValue({ ok: false, code: 'not_dispatchable', message: 'This agent is disabled.' })
    render(createElement(InboxView), { wrapper })
    const card = await screen.findByRole('article', { name: /queue is paused$/ })
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Resume' })) })
    expect(within(card).getByRole('alert').textContent).toBe('This agent is disabled.')
    expect(within(card).getByRole('button', { name: 'Resume' })).toBeTruthy()
  })
})
