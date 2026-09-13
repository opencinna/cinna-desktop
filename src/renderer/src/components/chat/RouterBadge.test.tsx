import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentData } from '../../../../preload'
import { RouterBadge } from './RouterBadge'
import { useAuthStore } from '../../stores/auth.store'

const runtime = vi.hoisted(() => ({ agent: { id: 'folder:one', path: '/Documents/CinnaAgents/Local/Research' } }))
vi.mock('../../hooks/useLocalAgents', () => ({ useLocalAgent: () => ({ data: runtime.agent }) }))
vi.mock('../agents/local/RuntimePanel', () => ({
  RuntimePanel: ({ agent, compact }: { agent: { id: string }; compact: boolean }) =>
    <div data-agent={agent.id}>{compact ? 'Shared runtime summary' : 'Settings controls'}</div>
}))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [{ id: 'credential', name: 'Work credential', baseUrl: 'https://api.anthropic.com' }] }) }))

const configuration = vi.fn()
const agent = (overrides: Partial<AgentData> = {}): AgentData => ({
  id: 'one', name: 'Research', source: 'local', driver: 'a2a', protocol: 'a2a',
  protocolInterfaceUrl: 'https://user:secret@agent.example.com:8443/rpc?token=secret',
  protocolInterfaceVersion: '0.3', hasAccessToken: true,
  ...overrides
} as AgentData)

function mount(connectionAgent: AgentData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><RouterBadge router="direct" connectionAgent={connectionAgent} /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ currentUser: null })
  Object.assign(window, { api: { customAgents: { configuration }, managedAgents: { configuration } } })
})

describe('agent connection badge', () => {
  it('labels a directly added A2A agent Remote and shows only safe endpoint details on hover', () => {
    mount(agent())
    const badge = screen.getByRole('status', { name: 'Remote agent connection' })
    expect(badge.textContent).toBe('Remote')
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(badge)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('A2A · 0.3')
    expect(tooltip.textContent).toContain('agent.example.com:8443')
    expect(tooltip.textContent).toContain('Access token')
    expect(tooltip.textContent).not.toContain('secret')
    expect(tooltip.textContent).not.toContain('/rpc')
    fireEvent.mouseLeave(badge.parentElement!)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on keyboard focus, stays while focused, and dismisses with Escape', () => {
    mount(agent())
    const badge = screen.getByRole('status')
    fireEvent.focus(badge)
    expect(badge.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    fireEvent.mouseLeave(badge.parentElement!)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.keyDown(badge, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('uses the shared local runtime summary and folder, without settings controls', () => {
    mount(agent({ id: 'folder:one', source: 'folder', driver: 'acp', protocol: 'acp' }))
    fireEvent.mouseEnter(screen.getByRole('status', { name: 'Local agent connection' }))
    expect(screen.getByRole('tooltip').textContent).toContain(runtime.agent.path)
    expect(screen.getByText('Shared runtime summary').getAttribute('data-agent')).toBe('folder:one')
    expect(screen.queryByText('Settings controls')).toBeNull()
    expect(configuration).not.toHaveBeenCalled()
  })

  it('shows Cinna profile authentication for a server agent', () => {
    mount(agent({ source: 'remote', hasAccessToken: false }))
    fireEvent.focus(screen.getByRole('status', { name: 'Remote agent connection' }))
    expect(screen.getByRole('tooltip').textContent).toContain('Cinna profile')
  })

  it('loads remote ACP configuration only on hover and shows domain and workspace', async () => {
    configuration.mockResolvedValue({ config: { transport: 'websocket', url: 'wss://acp.example.com/connect', cwd: '/workspace' } })
    mount(agent({ driver: 'acp', protocol: 'acp', acpTransport: 'websocket' }))
    expect(configuration).not.toHaveBeenCalled()
    fireEvent.mouseEnter(screen.getByRole('status', { name: 'Remote agent connection' }))
    expect(await screen.findByText('acp.example.com')).toBeTruthy()
    expect(screen.getByText('/workspace')).toBeTruthy()
    expect(screen.getByText('ACP · WebSocket')).toBeTruthy()
  })

  it('describes stdio ACP as a local process with agent-managed authentication', async () => {
    configuration.mockResolvedValue({ config: { launcher: 'custom', command: ['opencode', 'acp'], cwd: '/projects/agent' } })
    mount(agent({ driver: 'acp', protocol: 'acp', acpTransport: 'stdio' }))
    fireEvent.focus(screen.getByRole('status', { name: 'Local agent connection' }))
    expect(await screen.findByText('/projects/agent')).toBeTruthy()
    expect(screen.getByText('Managed by the ACP agent')).toBeTruthy()
  })

  it.each(['mouseEnter', 'focus'] as const)('describes the development builder on %s without requesting custom-agent configuration', (event) => {
    mount(agent({ name: 'Builder', development: true, driver: 'acp', protocol: 'acp', acpTransport: 'stdio' }))
    fireEvent[event](screen.getByRole('status', { name: 'Local agent connection' }))
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('Builder')
    expect(tooltip.textContent).toContain('ACP · stdio')
    expect(tooltip.textContent).toContain('This computer')
    expect(tooltip.textContent).toContain('Local Development')
    expect(configuration).not.toHaveBeenCalled()
    expect(screen.queryByText('Loading configuration…')).toBeNull()
  })

  it.each([
    ['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode']
  ] as const)('shows the saved %s driver for a builder without fetching its private configuration', (developmentEngine, label) => {
    mount(agent({ development: true, developmentEngine, driver: 'acp', protocol: 'acp', acpTransport: 'stdio' }))
    fireEvent.mouseEnter(screen.getByRole('status', { name: 'Local agent connection' }))
    expect(screen.getByText('Driver')).toBeTruthy()
    expect(screen.getByText(label)).toBeTruthy()
    expect(configuration).not.toHaveBeenCalled()
  })

  it('treats Claude Managed Agents as remote and names the configured credential', async () => {
    configuration.mockResolvedValue({ config: { credentialId: 'credential', environmentId: 'environment' } })
    mount(agent({ driver: 'managed', protocol: 'managed' }))
    fireEvent.focus(screen.getByRole('status', { name: 'Remote agent connection' }))
    expect(await screen.findByText('Work credential')).toBeTruthy()
    expect(screen.getByText('api.anthropic.com')).toBeTruthy()
  })

  it('keeps known transport details if fetching the configuration fails', async () => {
    configuration.mockRejectedValue(new Error('Unavailable'))
    mount(agent({ driver: 'acp', protocol: 'acp', acpTransport: 'websocket' }))
    fireEvent.focus(screen.getByRole('status', { name: 'Remote agent connection' }))
    expect(await screen.findByText('Configuration details unavailable')).toBeTruthy()
    expect(screen.getByText('ACP · WebSocket')).toBeTruthy()
  })
})
