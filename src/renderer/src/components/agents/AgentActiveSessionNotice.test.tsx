import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActiveSession, AgentActiveSessionsResult } from '../../../../shared/agentSessions'

/**
 * The warning before starting one more session on an agent that already runs
 * one: nothing while idle, one line naming the chat (or how many), and Open
 * going to the most recent. Kept fresh by main's pushes, never a timer.
 */

const active = vi.fn<() => Promise<AgentActiveSessionsResult>>()
const sessionListeners = new Set<() => void>()
const dispatchListeners = new Set<() => void>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  agentSessions: {
    active: () => active(),
    onChanged: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } }
  },
  taskDispatch: {
    onChanged: (listener: () => void) => { dispatchListeners.add(listener); return () => { dispatchListeners.delete(listener) } }
  },
  chat: { onTitleUpdated: () => () => {} }
}

const { AgentActiveSessionNotice } = await import('./AgentActiveSessionNotice')
const { useChatStore } = await import('../../stores/chat.store')
const { useUIStore } = await import('../../stores/ui.store')

const LEDGER = { id: 'folder:ledger', name: 'Ledger' }

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

function sessions(list: AgentActiveSession[]): void {
  active.mockResolvedValue({ ok: true, sessions: list })
}

async function renderNotice(agents = [LEDGER], props: Partial<Parameters<typeof AgentActiveSessionNotice>[0]> = {}): Promise<void> {
  render(createElement(AgentActiveSessionNotice, { agents, ...props }), { wrapper })
  await waitFor(() => expect(active).toHaveBeenCalled())
  await act(async () => {})
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  active.mockReset()
  useChatStore.setState({ activeChatId: null })
  useUIStore.setState({ activeView: 'tasks' })
})

afterEach(() => {
  cleanup()
})

describe('AgentActiveSessionNotice', () => {
  it('renders nothing while the agent runs no session, or only another agent does', async () => {
    sessions([{ agentId: 'folder:other', chatId: 'c-9', title: 'Elsewhere' }])
    await renderNotice()
    expect(document.querySelector('[data-agent-active-session]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('renders nothing before a profile is active', async () => {
    active.mockResolvedValue({ ok: false, code: 'not_activated', message: 'Sign in.' })
    await renderNotice()
    expect(document.querySelector('[data-agent-active-session]')).toBeNull()
  })

  it('names the one running chat, and Open goes to it', async () => {
    sessions([{ agentId: LEDGER.id, chatId: 'c-1', title: 'Reconcile August', startedAt: 1 }])
    await renderNotice()
    expect(screen.getByRole('status').textContent).toBe(
      'Ledger is already running in “Reconcile August”. Make sure this request won’t conflict with it. Open'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(useChatStore.getState().activeChatId).toBe('c-1')
    expect(useUIStore.getState().activeView).toBe('chat')
  })

  it('says “a chat” for an untitled one', async () => {
    sessions([{ agentId: LEDGER.id, chatId: 'c-1', title: null }])
    await renderNotice()
    expect(screen.getByRole('status').textContent).toContain('Ledger is already running in a chat.')
  })

  it('counts several sessions, and Open goes to the most recent', async () => {
    // Main lists them newest first.
    sessions([
      { agentId: LEDGER.id, chatId: 'c-new', title: 'Newest', startedAt: 2 },
      { agentId: LEDGER.id, chatId: 'c-old', title: 'Oldest', startedAt: 1 }
    ])
    await renderNotice()
    expect(screen.getByRole('status').textContent).toBe(
      'Ledger is already running in 2 sessions. Make sure this request won’t conflict with them. Open'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(useChatStore.getState().activeChatId).toBe('c-new')
  })

  it('gives each Open the sentence it acts on, when several agents are listed (§10)', async () => {
    // Mutation: drop `aria-describedby` → two identical "Open" buttons with nothing to tell them apart.
    sessions([
      { agentId: LEDGER.id, chatId: 'c-1', title: 'Reconcile August' },
      { agentId: 'folder:scout', chatId: 'c-2', title: 'Chart the shore' }
    ])
    await renderNotice([LEDGER, { id: 'folder:scout', name: 'Scout' }])
    const opens = screen.getAllByRole('button', { name: 'Open' })
    expect(opens).toHaveLength(2)
    const described = opens.map((button) => document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent)
    expect(described).toEqual([
      'Ledger is already running in “Reconcile August”. Make sure this request won’t conflict with it.',
      'Scout is already running in “Chart the shore”. Make sure this request won’t conflict with it.'
    ])
  })

  it('lets the sentence wrap rather than cutting its advice', async () => {
    sessions([{ agentId: LEDGER.id, chatId: 'c-1', title: 'A long title that would not fit beside the rest at 800px wide' }])
    await renderNotice()
    const status = screen.getByRole('status')
    expect(status.querySelector('.truncate')).toBeNull()
    // Open sits inline at the end of the sentence, in the same paragraph.
    expect(screen.getByRole('button', { name: 'Open' }).parentElement?.tagName).toBe('P')
  })

  it('on the Tasks tab, leaves out the sessions named elsewhere and says what Run next does', async () => {
    sessions([
      { agentId: LEDGER.id, chatId: 'c-run', title: 'Reconcile August' },
      { agentId: LEDGER.id, chatId: 'c-live', title: 'Ask about VAT' }
    ])
    await renderNotice([LEDGER], { advice: 'run-next', excludeChatIds: ['c-run'] })
    expect(screen.getByRole('status').textContent).toBe('Ledger is also running in “Ask about VAT”. Run next starts beside it. Open')
    cleanup()
    await renderNotice([LEDGER], { advice: 'run-next', excludeChatIds: ['c-run', 'c-live'] })
    expect(document.querySelector('[data-agent-active-session]')).toBeNull()
  })

  it('frozen, keeps what it showed at the gesture until its key changes', async () => {
    // Mutation: ignore `live` → the push below removes the notice.
    sessions([{ agentId: LEDGER.id, chatId: 'c-1', title: 'Reconcile August' }])
    const props = { live: false, snapshotKey: 'task-1' }
    const view = render(createElement(AgentActiveSessionNotice, { agents: [LEDGER], ...props }), { wrapper })
    await waitFor(() => expect(screen.queryByRole('status')).toBeTruthy())
    sessions([])
    await act(async () => { for (const listener of sessionListeners) listener() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(screen.getByRole('status').textContent).toContain('“Reconcile August”')
    // A new gesture (another task) takes a new snapshot.
    view.rerender(createElement(AgentActiveSessionNotice, { agents: [LEDGER], live: false, snapshotKey: 'task-2' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('appears and goes away on main’s pushes, with no timer', async () => {
    // Mutation: drop the subscriptions in `useAgentActiveSessions` → the notice keeps its first read.
    sessions([])
    await renderNotice()
    expect(screen.queryByRole('status')).toBeNull()

    sessions([{ agentId: LEDGER.id, chatId: 'c-1', title: 'Reconcile August' }])
    await act(async () => { for (const listener of sessionListeners) listener() })
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())

    sessions([])
    await act(async () => { for (const listener of dispatchListeners) listener() })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })
})
