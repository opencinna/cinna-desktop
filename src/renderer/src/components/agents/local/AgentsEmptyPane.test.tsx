import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The agent pane with nothing selected. With no agent of any kind it is the
 * way in — "Create a local agent" opens Add an agent at its name step, "Other
 * types of agents" at its advanced step. Otherwise it points at the sidebar,
 * or names the missing folder; and while the home is still being settled it
 * shows nothing, so the card never appears and then gives way.
 */

let folderAgents: unknown[] = []
let homeAccess: string | undefined = 'ready'
let settling = false
let external = { loaded: true, failed: false, count: 0 }
let localFailed = false
let addAgentDialog: string | null = null
let sidebarTab = 'agents'
const setAddAgentDialog = vi.fn()
const setSidebarTab = vi.fn()
const createHomeOnOpen = vi.fn()

vi.mock('../../../hooks/useLocalAgents', () => ({
  useLocalAgents: () => (localFailed ? { data: undefined, isError: true } : { data: { roots: [], agents: folderAgents, homeAccess, homeMissing: false }, isError: false }),
  useAgentsHomeQuestion: () => homeAccess,
  useAgentsHomeSettling: () => settling,
  useCreateAgentsHomeOnOpen: () => createHomeOnOpen()
}))
vi.mock('./useSidebarExternalAgents', () => ({ useSidebarExternalAgents: () => external }))
vi.mock('../../../stores/ui.store', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ sidebarTab, setSidebarTab, setAddAgentDialog, addAgentDialog })
}))

const { AgentsEmptyPane } = await import('./AgentsEmptyPane')

const CARD = { name: 'Create a local agent' }

beforeEach(() => {
  vi.clearAllMocks()
  folderAgents = []
  homeAccess = 'ready'
  settling = false
  external = { loaded: true, failed: false, count: 0 }
  localFailed = false
  addAgentDialog = null
  sidebarTab = 'agents'
})

describe('AgentsEmptyPane', () => {
  it('offers a first local agent when there are none of any kind, opening the name step', () => {
    render(createElement(AgentsEmptyPane))
    const card = screen.getByRole('button', CARD)
    expect(card.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.click(card)
    expect(setAddAgentDialog).toHaveBeenCalledWith('name')
    expect(setSidebarTab).not.toHaveBeenCalled()
    expect(createHomeOnOpen).toHaveBeenCalled()
  })

  it('opens the advanced step from "Other types of agents", showing the Agents tab first', () => {
    sidebarTab = 'chats'
    render(createElement(AgentsEmptyPane))
    fireEvent.click(screen.getByRole('button', { name: 'Other types of agents' }))
    expect(setSidebarTab).toHaveBeenCalledWith('agents')
    expect(setAddAgentDialog).toHaveBeenCalledWith('advanced')
  })

  it('points at the sidebar once there is any agent, folder or connected', () => {
    folderAgents = [{ id: 'folder:a' }]
    const view = render(createElement(AgentsEmptyPane))
    expect(screen.queryByRole('button', CARD)).toBeNull()
    expect(screen.getByText('Select an agent from the sidebar, or add one with +.')).toBeTruthy()
    view.unmount()
    folderAgents = []
    external = { loaded: true, failed: false, count: 1 }
    render(createElement(AgentsEmptyPane))
    expect(screen.queryByRole('button', CARD)).toBeNull()
  })

  it('names the missing folder for local agents, and still offers the other types', () => {
    for (const access of ['needs_consent', 'denied']) {
      homeAccess = access
      const view = render(createElement(AgentsEmptyPane))
      expect(screen.queryByRole('button', CARD)).toBeNull()
      expect(screen.getByText('Local agents need a folder before you can add one.')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Other types of agents' }))
      expect(setAddAgentDialog).toHaveBeenLastCalledWith('advanced')
      view.unmount()
    }
  })

  it('falls back to the sidebar line when a list failed, instead of staying blank', () => {
    localFailed = true
    const view = render(createElement(AgentsEmptyPane))
    expect(screen.getByText('Select an agent from the sidebar, or add one with +.')).toBeTruthy()
    view.unmount()
    localFailed = false
    external = { loaded: false, failed: true, count: 0 }
    render(createElement(AgentsEmptyPane))
    expect(screen.getByText('Select an agent from the sidebar, or add one with +.')).toBeTruthy()
  })

  it('returns focus to the card when the dialog it opened closes', () => {
    const view = render(createElement(AgentsEmptyPane))
    const card = screen.getByRole('button', CARD)
    fireEvent.click(card)
    addAgentDialog = 'name'
    view.rerender(createElement(AgentsEmptyPane))
    ;(document.activeElement as HTMLElement | null)?.blur()
    addAgentDialog = null
    view.rerender(createElement(AgentsEmptyPane))
    expect(document.activeElement).toBe(screen.getByRole('button', CARD))
  })

  it('shows nothing while the home is being settled or the agents are loading', () => {
    settling = true
    const view = render(createElement(AgentsEmptyPane))
    expect(view.container.textContent).toBe('')
    view.unmount()
    settling = false
    external = { loaded: false, failed: false, count: 0 }
    const again = render(createElement(AgentsEmptyPane))
    expect(again.container.textContent).toBe('')
  })
})
