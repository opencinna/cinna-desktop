import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { window.api = { app: { setTheme: async () => {} } } as unknown as typeof window.api })
import { ExternalAgentPage } from './ExternalAgentPage'
import { useUIStore } from '../../stores/ui.store'
import { openAgentTab } from '../dashboards/componentParts'

/** A cloud agent's page gains Dashboards for agents the profile owns (D6.8, D6.9). */

const OWNED = { id: 'remote-own', name: 'Cloud Sales', source: 'remote', driver: 'a2a', protocol: 'a2a', enabled: true, remoteTargetType: 'agent', remoteTargetId: 'core-1', remoteMetadata: null }
const SHARED = { ...OWNED, id: 'remote-shared', name: 'Team Bot', remoteMetadata: { can_build: false } }
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [OWNED, SHARED] }) }))
vi.mock('./AgentTypeIcon', () => ({ AgentTypeIcon: () => null }))
vi.mock('./ExternalAgentActionsMenu', () => ({ ExternalAgentActionsMenu: () => null }))
vi.mock('../settings/AgentCard', () => ({ AgentCard: () => null }))
vi.mock('./CustomAgentModal', () => ({ CustomAgentModal: () => null }))
vi.mock('./ManagedAgentModal', () => ({ ManagedAgentModal: () => null }))
vi.mock('../layout/ChatWorkspace', () => ({ ChatWorkspace: () => null }))
vi.mock('../dashboards/AgentDashboardsTab', () => ({ CloudAgentDashboardsTab: ({ agent }: { agent: { name: string } }) => <p>Components of {agent.name}</p> }))

function show() {
  return render(<QueryClientProvider client={new QueryClient()}><ExternalAgentPage /></QueryClientProvider>)
}

beforeEach(() => {
  useUIStore.setState({ activeView: 'external-agent', agentPageMode: 'settings', agentPageTabRequest: null })
})

describe('a cloud agent’s Dashboards tab', () => {
  it('is there for an agent the profile owns', () => {
    useUIStore.setState({ activeExternalAgentId: 'remote-own' })
    show()
    fireEvent.click(screen.getByRole('tab', { name: 'Dashboards' }))
    expect(screen.getByText('Components of Cloud Sales')).toBeTruthy()
  })

  it('is not there for one shared with the profile', () => {
    useUIStore.setState({ activeExternalAgentId: 'remote-shared' })
    show()
    expect(screen.queryByRole('tab', { name: 'Dashboards' })).toBeNull()
  })

  it('a tile’s Open agent lands on Dashboards; a tab the page lacks shows Overview', () => {
    act(() => openAgentTab('remote-own', 'dashboards'))
    const { unmount } = show()
    expect(screen.getByRole('tab', { name: 'Dashboards', selected: true })).toBeTruthy()
    expect(useUIStore.getState().agentPageTabRequest).toBeNull()
    unmount()
    act(() => openAgentTab('remote-own', 'credentials'))
    show()
    expect(screen.getByRole('tab', { name: 'Overview', selected: true })).toBeTruthy()
  })
})
