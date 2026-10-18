import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentDispatchState,
  TaskDispatchMode,
  TaskDispatchRunResult,
  TaskDispatchUpdateResult
} from '../../../../../shared/taskDispatch'
import type { AgentActiveSessionsResult } from '../../../../../shared/agentSessions'

/**
 * A folder agent's Tasks tab: the run mode, Run next beside the section
 * title, the one status line that is true in every state, and the paused
 * line with Resume. Every refusal is main's sentence, shown last in the card,
 * and nothing it shows moves the controls above it.
 */

const getQueue = vi.fn<(agentId: string) => Promise<AgentDispatchState | null>>()
const setMode = vi.fn<(agentId: string, mode: TaskDispatchMode, maxRuns?: number) => Promise<TaskDispatchUpdateResult>>()
const resume = vi.fn<(agentId: string) => Promise<TaskDispatchUpdateResult>>()
const runNext = vi.fn<(agentId: string, taskId?: string) => Promise<TaskDispatchRunResult>>()
const activeSessions = vi.fn<() => Promise<AgentActiveSessionsResult>>(async () => ({ ok: true, sessions: [] }))

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  taskDispatch: {
    get: (agentId: string) => getQueue(agentId),
    setMode: (...args: [string, TaskDispatchMode, number?]) => setMode(...args),
    resume: (agentId: string) => resume(agentId),
    runNext: (agentId: string, taskId?: string) => runNext(agentId, taskId),
    onChanged: () => () => {}
  },
  agentSessions: { active: () => activeSessions(), onChanged: () => () => {} },
  chat: { onTitleUpdated: () => () => {} }
}

const { AgentTasksTab } = await import('./AgentTasksTab')
const { useUIStore } = await import('../../../stores/ui.store')

const AGENT = { id: 'folder:ledger', name: 'Ledger' }

function queue(overrides: Partial<AgentDispatchState> = {}): AgentDispatchState {
  return { agentId: AGENT.id, mode: 'manual', maxRuns: null, paused: null, running: [], next: null, waiting: null, ...overrides }
}

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

async function renderTab(state: AgentDispatchState | null): Promise<void> {
  getQueue.mockResolvedValue(state)
  // A fresh cache per render: a test that renders several states must not read the last one's.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  render(createElement(AgentTasksTab, { agent: AGENT }), { wrapper })
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
}

function statusLine(): string {
  return document.querySelector('[data-queue-status]')!.textContent ?? ''
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  getQueue.mockReset()
  setMode.mockReset()
  resume.mockReset()
  runNext.mockReset()
  useUIStore.setState({ activeView: 'local-agent', activeTaskId: null, revealInboxGateId: null } as never)
})
afterEach(cleanup)

describe('AgentTasksTab', () => {
  it('is one titled section with Run next beside the title and the explanation behind the (?)', async () => {
    await renderTab(queue())
    const heading = screen.getByRole('heading', { name: 'Task queue' })
    expect(heading.className).toContain('text-[14px]')
    expect(heading.parentElement!.textContent).toContain('Run next')
    expect(screen.getByRole('button', { name: 'About the task queue' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'About Run mode' })).toBeTruthy()
    expect((screen.getByLabelText('Run mode') as HTMLSelectElement).value).toBe('manual')
  })

  it('says something true on the status line in every state', async () => {
    await renderTab(queue())
    expect(statusLine()).toBe('No Ready tasks')
    cleanup()

    await renderTab(queue({ next: { taskId: 't2', title: 'Close the books', needsApproval: false } }))
    expect(statusLine()).toBe('Next: Close the books')
    cleanup()

    // Run next would open the approval, so the line says so.
    await renderTab(queue({ next: { taskId: 't2', title: 'Close the books', needsApproval: true } }))
    expect(statusLine()).toBe('Next: Close the books — needs approval')
    cleanup()

    await renderTab(queue({ mode: 'one', next: { taskId: 't2', title: 'Close the books', needsApproval: false }, waiting: 'slot' }))
    expect(statusLine()).toBe('Waiting for a runner slot')
    cleanup()

    await renderTab(queue({ mode: 'one', waiting: 'gate' }))
    expect(statusLine()).toBe('Waiting for approval in the Inbox')
    cleanup()

    await renderTab(queue({ running: [{ taskId: 't1', chatId: 'c1', title: 'Reconcile August' }] }))
    expect(statusLine()).toBe('Running Reconcile August')
    // The task is a link to its page.
    fireEvent.click(within(document.querySelector('[data-queue-status]') as HTMLElement).getByRole('button', { name: 'Reconcile August' }))
    expect(useUIStore.getState().activeView).toBe('task')
    expect(useUIStore.getState().activeTaskId).toBe('t1')
  })

  it('saves the run mode and shows main’s refusal last in the card', async () => {
    await renderTab(queue())
    setMode.mockResolvedValueOnce({ ok: true, state: queue({ mode: 'one' }) })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Run mode'), { target: { value: 'one' } })
    })
    expect(setMode).toHaveBeenCalledWith(AGENT.id, 'one')
    expect((screen.getByLabelText('Run mode') as HTMLSelectElement).value).toBe('one')

    setMode.mockResolvedValueOnce({ ok: false, code: 'not_dispatchable', message: 'This agent is disabled.' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Run mode'), { target: { value: 'manual' } })
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('This agent is disabled.')
    // Last in the card: nothing after it.
    expect(alert.nextElementSibling).toBeNull()
  })

  it('offers Up to 2 … Up to 8 in the one Run mode select, with no second control', async () => {
    await renderTab(queue())
    const select = screen.getByLabelText('Run mode') as HTMLSelectElement
    expect([...select.options].map((o) => o.text)).toEqual([
      'Manual', 'One at a time', 'Up to 2', 'Up to 3', 'Up to 4', 'Up to 5', 'Up to 6', 'Up to 7', 'Up to 8'
    ])
    // One control on the row: nothing held beside it, nothing to appear (§1).
    expect(select.parentElement!.querySelectorAll('select')).toHaveLength(1)
    expect(document.querySelector('[data-queue-max-runs]')).toBeNull()

    setMode.mockResolvedValueOnce({ ok: true, state: queue({ mode: 'up_to', maxRuns: 3 }) })
    getQueue.mockResolvedValue(queue({ mode: 'up_to', maxRuns: 3 }))
    await act(async () => {
      fireEvent.change(select, { target: { value: 'up_to:3' } })
    })
    expect(setMode).toHaveBeenCalledWith(AGENT.id, 'up_to', 3)
    await waitFor(() => expect(select.options[select.selectedIndex].text).toBe('Up to 3'))

    setMode.mockResolvedValueOnce({ ok: true, state: queue({ mode: 'one' }) })
    getQueue.mockResolvedValue(queue({ mode: 'one' }))
    await act(async () => { fireEvent.change(select, { target: { value: 'one' } }) })
    expect(setMode).toHaveBeenLastCalledWith(AGENT.id, 'one')
    await waitFor(() => expect(select.value).toBe('one'))
  })

  it('shows a saved Up to N as its own choice', async () => {
    await renderTab(queue({ mode: 'up_to', maxRuns: 6 }))
    const select = screen.getByLabelText('Run mode') as HTMLSelectElement
    expect(select.options[select.selectedIndex].text).toBe('Up to 6')
  })

  it('says how full an Up to N queue is', async () => {
    const run = (id: string, title: string) => ({ taskId: id, chatId: `c-${id}`, title })
    await renderTab(queue({ mode: 'up_to', maxRuns: 3, running: [run('t1', 'Reconcile August'), run('t2', 'Close the books')] }))
    expect(statusLine()).toBe('Running 2 of 3')
    cleanup()

    await renderTab(queue({ mode: 'up_to', maxRuns: 3, running: [run('t1', 'Reconcile August')], waiting: 'slot' }))
    expect(statusLine()).toBe('Running Reconcile August · 1 of 3 · waiting for a runner slot')
    cleanup()

    // Run next starts beyond the count: more than N, or more than one outside Up to N.
    await renderTab(queue({ mode: 'up_to', maxRuns: 2, running: [run('t1', 'A'), run('t2', 'B'), run('t3', 'C')] }))
    expect(statusLine()).toBe('Running 3 tasks')
    cleanup()
    await renderTab(queue({ mode: 'one', running: [run('t1', 'A'), run('t2', 'B')] }))
    expect(statusLine()).toBe('Running 2 tasks')
  })

  it('warns under the queue when the agent already runs a session, and stays quiet when idle', async () => {
    await renderTab(queue())
    expect(document.querySelector('[data-agent-active-session]')).toBeNull()
    cleanup()

    activeSessions.mockResolvedValue({ ok: true, sessions: [{ agentId: AGENT.id, chatId: 'c-7', title: 'Month end' }] })
    await renderTab(queue())
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toBe('Ledger is also running in “Month end”. Run next starts beside it. Open')
    // The settings scale, as the rest of the tab (§12).
    expect(notice.className).toContain('text-[13px]')
    // Last in the card, after the status line.
    const card = document.querySelector('[data-queue-status]')!.parentElement!
    expect(card.lastElementChild?.hasAttribute('data-agent-active-session')).toBe(true)
    activeSessions.mockResolvedValue({ ok: true, sessions: [] })
  })

  it('names only the sessions the status line does not: a live chat beside the queue’s own runs', async () => {
    // Mutation: drop `excludeChatIds` → the queue's running task is named twice, once in the status line and once here.
    try {
      activeSessions.mockResolvedValue({ ok: true, sessions: [{ agentId: AGENT.id, chatId: 'c-run', title: 'Reconcile August' }] })
      await renderTab(queue({ mode: 'one', running: [{ taskId: 't1', chatId: 'c-run', title: 'Reconcile August' }] }))
      expect(statusLine()).toBe('Running Reconcile August')
      await waitFor(() => expect(activeSessions).toHaveBeenCalled())
      await act(async () => {})
      expect(document.querySelector('[data-agent-active-session]')).toBeNull()
      cleanup()

      activeSessions.mockResolvedValue({ ok: true, sessions: [
        { agentId: AGENT.id, chatId: 'c-live', title: 'Ask about VAT' },
        { agentId: AGENT.id, chatId: 'c-run', title: 'Reconcile August' }
      ] })
      await renderTab(queue({ mode: 'one', running: [{ taskId: 't1', chatId: 'c-run', title: 'Reconcile August' }] }))
      expect((await screen.findByRole('status')).textContent).toBe('Ledger is also running in “Ask about VAT”. Run next starts beside it. Open')
      cleanup()

      activeSessions.mockResolvedValue({ ok: true, sessions: [
        { agentId: AGENT.id, chatId: 'c-live', title: 'Ask about VAT' },
        { agentId: AGENT.id, chatId: 'c-other', title: null }
      ] })
      await renderTab(queue())
      expect((await screen.findByRole('status')).textContent).toBe('Ledger is also running in 2 sessions. Run next starts beside them. Open')
    } finally {
      activeSessions.mockResolvedValue({ ok: true, sessions: [] })
    }
  })

  it('runs the next task and stays on the page', async () => {
    await renderTab(queue({ next: { taskId: 't2', title: 'Close the books', needsApproval: false } }))
    runNext.mockResolvedValue({ ok: true, taskId: 't2', chatId: 'c2' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Run next/ })) })
    expect(runNext).toHaveBeenCalledWith(AGENT.id, undefined)
    expect(useUIStore.getState().activeView).toBe('local-agent')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens the Inbox on the approval a gated task needs', async () => {
    await renderTab(queue())
    runNext.mockResolvedValue({ ok: true, gate: 'g-1' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Run next/ })) })
    expect(useUIStore.getState().activeView).toBe('inbox')
    expect(useUIStore.getState().revealInboxGateId).toBe('g-1')
  })

  it('shows a refused Run next in the card, and a rejected one unwrapped', async () => {
    await renderTab(queue())
    runNext.mockResolvedValueOnce({ ok: false, code: 'nothing_eligible', message: 'This agent has no Ready task that can run now.' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Run next/ })) })
    expect(screen.getByRole('alert').textContent).toBe('This agent has no Ready task that can run now.')

    runNext.mockRejectedValueOnce(new Error("Error invoking remote method 'taskDispatch:run-next': Error: Not activated"))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Run next/ })) })
    expect(screen.getByRole('alert').textContent).toBe('Not activated')
  })

  it.each([
    ['unreported', 'Paused — Reconcile August ended without reporting'],
    ['error', 'Paused — Reconcile August failed'],
    ['stopped', 'Paused — Reconcile August was stopped'],
    ['interrupted', 'Paused — Reconcile August was interrupted when Cinna quit']
  ] as const)('says why a queue paused (%s) and resumes it', async (reason, text) => {
    await renderTab(queue({ mode: 'one', paused: { reason, taskId: 't1', taskTitle: 'Reconcile August', at: 1 } }))
    const line = document.querySelector('[data-queue-paused]') as HTMLElement
    expect(line.textContent).toBe(`${text}Resume`)
    resume.mockResolvedValue({ ok: true, state: queue({ mode: 'one' }) })
    await act(async () => { fireEvent.click(within(line).getByRole('button', { name: 'Resume' })) })
    expect(resume).toHaveBeenCalledWith(AGENT.id)
    await waitFor(() => expect(document.querySelector('[data-queue-paused]')).toBeNull())
  })

  it('keeps the paused line and says why when Resume is refused', async () => {
    await renderTab(queue({ paused: { reason: 'unreported', taskId: null, taskTitle: null, at: 1 } }))
    expect((document.querySelector('[data-queue-paused]') as HTMLElement).textContent).toBe('Paused — the last task ended without reportingResume')
    resume.mockResolvedValue({ ok: false, code: 'not_dispatchable', message: 'This agent is disabled.' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume' })) })
    expect(screen.getByRole('alert').textContent).toBe('This agent is disabled.')
    expect(document.querySelector('[data-queue-paused]')).not.toBeNull()
  })

  it('says a disabled agent has no queue, and offers nothing to press', async () => {
    await renderTab(null)
    expect(screen.getByText(/This agent is disabled/)).toBeTruthy()
    expect(screen.queryByLabelText('Run mode')).toBeNull()
    expect((screen.getByRole('button', { name: /Run next/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
