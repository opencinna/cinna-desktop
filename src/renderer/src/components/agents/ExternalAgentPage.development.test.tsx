import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { window.api = { app: { setTheme: async () => {} } } as unknown as typeof window.api })
import { ExternalAgentPage } from './ExternalAgentPage'
import { useUIStore } from '../../stores/ui.store'
import { useLocalDevStore } from '../../stores/localDev.store'

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [{ id: 'builder', name: 'Build', source: 'local', driver: 'acp', protocol: 'acp', development: true }] }) }))
vi.mock('./AgentTypeIcon', () => ({ AgentTypeIcon: () => null }))
vi.mock('./ExternalAgentActionsMenu', () => ({ ExternalAgentActionsMenu: () => null }))
vi.mock('../settings/AgentCard', () => ({ AgentCard: () => null }))
vi.mock('./CustomAgentModal', () => ({ CustomAgentModal: () => <div>Custom command editor</div> }))
vi.mock('./ManagedAgentModal', () => ({ ManagedAgentModal: () => null }))
vi.mock('../layout/ChatWorkspace', () => ({ ChatWorkspace: () => <textarea aria-label="Build message" /> }))

describe('internal builder settings', () => {
  it('routes Settings to Local Development even when another agent left settings mode selected', () => {
    useUIStore.setState({ activeView: 'external-agent', activeExternalAgentId: 'builder', agentPageMode: 'settings' })
    useLocalDevStore.setState({ pageMode: 'chat' })
    render(<QueryClientProvider client={new QueryClient()}><ExternalAgentPage /></QueryClientProvider>)
    expect(screen.getByRole('textbox', { name: 'Build message' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Configure' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(useUIStore.getState().activeView).toBe('local-development')
    expect(useLocalDevStore.getState().pageMode).toBe('settings')
    expect(screen.queryByText('Custom command editor')).toBeNull()
  })
})
