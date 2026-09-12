import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  currentUser: { id: 'profile', type: 'cinna_user', cinnaServerUrl: 'https://core.example.com' },
  agents: [
    { id: 'remote', source: 'remote', protocol: 'a2a', name: 'Cinna agent', enabled: false },
    { id: 'direct', source: 'local', protocol: 'a2a', name: 'Direct A2A', enabled: true },
    { id: 'acp', source: 'local', driver: 'acp', name: 'Custom ACP', enabled: true }
  ]
}))
vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ data: state.agents }),
  useRemoteSyncStatus: () => ({}),
  useSyncRemoteAgents: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('../../hooks/useAuth', () => ({ useCinnaReauth: () => ({}) }))
vi.mock('../../hooks/useAgentDesktopVisibility', () => ({ useAgentDesktopVisibility: () => ({ setVisible: vi.fn(), isPending: false }) }))
vi.mock('../../stores/auth.store', () => ({ useAuthStore: (select: (store: typeof state) => unknown) => select(state) }))
vi.mock('../../stores/ui.store', () => ({ useUIStore: { getState: vi.fn() } }))
import { AgentsSettingsSection } from './AgentsSettingsSection'

describe('profile agent settings', () => {
  it('lists only Cinna server agents, including disabled ones for re-enabling', () => {
    render(<AgentsSettingsSection />)
    expect(screen.getByRole('heading', { name: 'core.example.com' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable Cinna agent in Desktop App' })).toBeTruthy()
    expect(screen.queryByText('Direct A2A')).toBeNull()
    expect(screen.queryByText('Custom ACP')).toBeNull()
  })
})
