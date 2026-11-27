import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { window.api = { app: { setTheme: async () => {} } } as unknown as typeof window.api })
import { ExternalAgentPage } from './ExternalAgentPage'
import { useUIStore } from '../../stores/ui.store'

const agents = ['alpha', 'beta', 'gamma'].map((id) => ({
  id, name: id, source: 'remote', driver: 'a2a', protocol: 'a2a', enabled: true,
  remoteTargetType: 'agent', remoteTargetId: `core-${id}`
}))

vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
// Details answers after mount, as main does: the button appears a tick after its siblings.
vi.mock('../../hooks/useAgentDetails', () => ({
  useAgentDetails: () => {
    const [data, setData] = useState<{ ok: true } | undefined>(undefined)
    useEffect(() => { const timer = setTimeout(() => setData({ ok: true }), 0); return () => clearTimeout(timer) }, [])
    return { data }
  }
}))
vi.mock('./AgentTypeIcon', () => ({ AgentTypeIcon: () => null }))
vi.mock('./ExternalAgentActionsMenu', () => ({ ExternalAgentActionsMenu: () => <button type="button">More actions</button> }))
vi.mock('../settings/AgentCard', () => ({ AgentCard: () => null }))
vi.mock('./AgentInterfaceTab', () => ({ AgentInterfaceTab: () => null }))
vi.mock('../dashboards/AgentDashboardsTab', () => ({ CloudAgentDashboardsTab: () => null }))
vi.mock('../layout/ChatWorkspace', () => ({ ChatWorkspace: () => null }))

const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })

describe('ExternalAgentPage header', () => {
  it('keeps one Details button and one menu while the sidebar switches agents', async () => {
    useUIStore.setState({ activeView: 'external-agent', activeExternalAgentId: 'alpha', agentPageMode: 'settings' })
    render(<QueryClientProvider client={new QueryClient()}><ExternalAgentPage /></QueryClientProvider>)
    await settle()
    for (const id of ['beta', 'gamma', 'alpha', 'beta']) {
      act(() => useUIStore.setState({ activeExternalAgentId: id }))
      await settle()
      expect(screen.getAllByRole('button', { name: /details/i })).toHaveLength(1)
      expect(screen.getAllByRole('button', { name: 'More actions' })).toHaveLength(1)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(id)
    }
  })
})
