import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxSnapshot, TeamChangedInboxItem } from '../../../../shared/inbox'
import type { AgentShareResult, SharingOutcome } from '../../../../shared/agentSharing'

/**
 * "The team changed X": a shared agent the team moved past, with Update. A
 * clean Update settles the card in place; a conflict takes the user to the
 * agent page, where the two-button choice lives; any other refusal stays on
 * the card beside its button.
 */

const listMock = vi.fn<() => Promise<InboxSnapshot>>()
const update = vi.fn<(agentId: string) => Promise<SharingOutcome<AgentShareResult>>>()

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  inbox: { list: () => listMock(), answer: vi.fn() },
  sharing: { update: (agentId: string) => update(agentId) },
  tasks: { list: async () => [] },
  agents: {
    list: async () => [{ id: 'folder:payroll', name: 'Payroll Checker' }],
    onRemoteSyncComplete: () => () => {},
    onReadinessChanged: () => () => {}
  }
}

const { InboxView } = await import('./InboxView')
const { useUIStore } = await import('../../stores/ui.store')
const { SHARE_REFUSAL_TEXT, SHARE_UI_TEXT } = await import('../../utils/shareText')

const ITEM: TeamChangedInboxItem = {
  kind: 'team_changed',
  agentId: 'folder:payroll',
  agentName: 'Payroll Checker',
  repoId: 'r-payroll',
  changedBy: 'Dana Ruiz',
  changedAt: new Date('2026-10-08T10:00:00Z')
}

function result(overrides: Partial<AgentShareResult>): SharingOutcome<AgentShareResult> {
  return { success: true, value: { done: true, refusal: null, detail: null, status: null, agentId: null, ...overrides } }
}

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

function card(): HTMLElement {
  return screen.getByRole('article', { name: SHARE_UI_TEXT.teamChanged('Payroll Checker') })
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  listMock.mockReset().mockResolvedValue({ entries: [], unreadable: [], dispatch: [], teamChanges: [ITEM] })
  update.mockReset()
  useUIStore.setState({ activeView: 'inbox', activeLocalAgentId: null } as never)
})

describe('The team changed X', () => {
  it('names the agent, who changed it, and links the name to the agent page', async () => {
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.teamChanged('Payroll Checker') })
    expect(card().textContent).toContain('Dana Ruiz')
    fireEvent.click(within(card()).getByRole('button', { name: 'Payroll Checker' }))
    expect(useUIStore.getState().activeView).toBe('local-agent')
    expect(useUIStore.getState().activeLocalAgentId).toBe('folder:payroll')
  })

  it('updates, and keeps the card with what it settled as after the next read drops it', async () => {
    update.mockResolvedValue(result({}))
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.teamChanged('Payroll Checker') })
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(update).toHaveBeenCalledWith('folder:payroll')
    listMock.mockResolvedValue({ entries: [], unreadable: [], dispatch: [], teamChanges: [] })
    await act(async () => {
      await client.refetchQueries({ queryKey: ['inbox'] })
    })
    expect(within(card()).getByRole('status').textContent).toBe(SHARE_UI_TEXT.updated)
  })

  it('a conflict opens the agent page, where the choice is', async () => {
    update.mockResolvedValue(result({ done: false, refusal: 'diverged_conflict' }))
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.teamChanged('Payroll Checker') })
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(useUIStore.getState().activeView).toBe('local-agent')
    expect(useUIStore.getState().activeLocalAgentId).toBe('folder:payroll')
  })

  it('any other refusal stays on the card beside Update', async () => {
    update.mockResolvedValue(result({ done: false, refusal: 'dirty' }))
    render(createElement(InboxView), { wrapper })
    await screen.findByRole('article', { name: SHARE_UI_TEXT.teamChanged('Payroll Checker') })
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: SHARE_UI_TEXT.update }))
    })
    expect(within(card()).getByRole('alert').textContent).toBe(SHARE_REFUSAL_TEXT.dirty)
    expect(within(card()).getByRole('button', { name: SHARE_UI_TEXT.update })).toBeTruthy()
  })
})
