import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRootDto, LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * The sidebar row's chat action. It is the jobs row's run-now button with a
 * different verb: visible on hover, in a slot the row always reserves, and it
 * starts a chat the way the page's "Start chat" does — `setActiveView('chat')`
 * + `setPendingAgentId` — without also opening the agent page beside it.
 * Unlike the page's button it then moves the sidebar to Chats.
 *
 * The button is a *sibling* of the row, not a child: a labelled button inside
 * a `role="button"` joins the row's accessible name, and the row is found by
 * the agent's name alone in every E2E spec. As a sibling it can stay in the
 * tree (hidden by opacity, like the chat list's delete button), so it is also
 * reachable by keyboard.
 */

const setActiveView = vi.fn()
const setPendingAgentId = vi.fn()
const setActiveLocalAgentId = vi.fn()
const setSidebarTab = vi.fn()
vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeLocalAgentId: null,
      activeView: 'local-agent',
      setActiveLocalAgentId,
      setActiveView,
      setPendingAgentId,
      setSidebarTab
    })
}))

const ROOT: AgentRootDto = {
  id: 'root-1',
  path: '/tmp/agents',
  label: 'Agents',
  isDefault: true,
  kind: 'workshop',
  exists: true,
  agentCount: 1,
  truncated: false
} as AgentRootDto

let AGENTS: LocalAgentDto[] = []

const AGENT = {
  id: 'folder:alpha',
  name: 'Alpha',
  description: 'Alpha',
  path: '/tmp/agents/alpha',
  rootId: 'root-1',
  readiness: 'ok',
  readinessReason: null,
  status: null,
  validation: { errors: [], warnings: [], infos: [] },
  commands: [],
  stamps: {}
} as unknown as LocalAgentDto

vi.mock('../../../hooks/useLocalAgents', () => ({
  useLocalAgents: () => ({
    data: { roots: [ROOT], agents: AGENTS },
    isLoading: false,
    error: null
  }),
  useAgentCredentialBindings: () => ({ data: [] }),
  useAgentsHomeQuestion: () => 'ready',
  useRaiseAgentsHomeQuestion: () => undefined
}))
vi.mock('../../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('./NewLocalAgentModal', () => ({ NewLocalAgentModal: () => null }))

const { LocalAgentsList } = await import('./LocalAgentsList')

function renderList(): void {
  const client = new QueryClient()
  render(createElement(QueryClientProvider, { client }, createElement(LocalAgentsList)))
}

const CHAT = /start a new chat with alpha/i

describe('LocalAgentsList — the row’s chat button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    AGENTS = [AGENT]
  })

  it('lends the row nothing: the row is a button named by the agent alone', () => {
    renderList()
    const row = screen.getByRole('button', { name: 'Alpha' })
    expect(row.tagName).toBe('BUTTON')
    expect(row.textContent).toBe('Alpha')
    // Present and reachable, not rendered on hover: no `tabindex="-1"`.
    const chat = screen.getByRole('button', { name: CHAT })
    expect(chat.getAttribute('tabindex')).toBeNull()
    expect(row.contains(chat)).toBe(false)
  })

  it('starts a chat the way the page’s Start chat does, without opening the page', () => {
    renderList()
    fireEvent.click(screen.getByRole('button', { name: CHAT }))
    expect(setActiveView).toHaveBeenCalledTimes(1)
    expect(setActiveView).toHaveBeenCalledWith('chat')
    expect(setPendingAgentId).toHaveBeenCalledWith('folder:alpha')
    // The sidebar follows the chat into the Chats tab.
    expect(setSidebarTab).toHaveBeenCalledWith('chats')
    expect(setActiveLocalAgentId).not.toHaveBeenCalled()
  })

  it('the row itself still opens the agent page', () => {
    renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
    expect(setActiveLocalAgentId).toHaveBeenCalledWith('folder:alpha')
    expect(setActiveView).toHaveBeenCalledWith('local-agent')
    expect(setPendingAgentId).not.toHaveBeenCalled()
    expect(setSidebarTab).not.toHaveBeenCalled()
  })

  it('is withheld on a row the chat could not attach to', () => {
    // A duplicate-id folder is listed but never indexed: the new-chat screen
    // would look it up, find nothing, and show nothing, and its page offers no
    // Start chat. The gate is on `readiness` and so also covers an indexed
    // folder with an invalid manifest, which cannot run a turn either.
    AGENTS = [
      {
        ...AGENT,
        id: 'folder:duplicate:alpha',
        readiness: 'invalid',
        readinessReason: 'Another folder already claims this id.'
      } as LocalAgentDto
    ]
    renderList()
    expect(screen.getByRole('button', { name: /^Alpha/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: CHAT })).toBeNull()
  })
})
