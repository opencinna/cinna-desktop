import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  currentUser: { id: 'profile', type: 'cinna_user', cinnaServerUrl: 'https://core.example.com' },
  agents: [
    { id: 'remote', source: 'remote', protocol: 'a2a', name: 'Cinna agent', enabled: false },
    { id: 'shown', source: 'remote', protocol: 'a2a', name: 'Ledger helper', description: 'Reads the ledger', enabled: true },
    { id: 'direct', source: 'local', protocol: 'a2a', name: 'Direct A2A', enabled: true },
    { id: 'acp', source: 'local', driver: 'acp', name: 'Custom ACP', enabled: true }
  ],
  syncError: undefined as string | undefined
}))
vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ data: state.agents }),
  useRemoteSyncStatus: () => ({ error: state.syncError }),
  useSyncRemoteAgents: () => ({ mutate: sync, isPending: false })
}))
vi.mock('../../hooks/useAuth', () => ({ useCinnaReauth: () => ({}) }))
const setVisible = vi.hoisted(() => vi.fn())
const ui = vi.hoisted(() => ({
  setActiveExternalAgentId: vi.fn(), setAgentPageMode: vi.fn(), setSidebarTab: vi.fn(), setActiveView: vi.fn()
}))
const sync = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useAgentDesktopVisibility', () => ({ useAgentDesktopVisibility: () => ({ setVisible, isPending: false }) }))
vi.mock('../../stores/auth.store', () => ({ useAuthStore: (select: (store: typeof state) => unknown) => select(state) }))
vi.mock('../../stores/ui.store', () => ({ useUIStore: { getState: () => ui } }))
import { AgentsSettingsSection } from './AgentsSettingsSection'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  state.syncError = undefined
})

describe('profile agent settings', () => {
  it('lists only Cinna server agents, including disabled ones for re-enabling', () => {
    render(<AgentsSettingsSection />)
    expect(screen.getByRole('heading', { name: 'core.example.com' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Show Cinna agent in Desktop' })).toBeTruthy()
    expect(screen.queryByText('Direct A2A')).toBeNull()
    expect(screen.queryByText('Custom ACP')).toBeNull()
  })

  it('draws each agent as a settings card: a switch for Shown in Desktop, its settings behind an icon only while shown', () => {
    render(<AgentsSettingsSection />)
    const hidden = screen.getByRole('switch', { name: 'Show Cinna agent in Desktop' })
    expect(hidden.getAttribute('aria-checked')).toBe('false')
    const shown = screen.getByRole('switch', { name: 'Show Ledger helper in Desktop' })
    expect(shown.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Hidden from Desktop')).toBeTruthy()
    expect(screen.getByText('Reads the ledger')).toBeTruthy()
    // Settings only for a shown agent; the hidden one keeps the slot, so both switches line up.
    expect(screen.queryByRole('button', { name: 'Open Cinna agent settings' })).toBeNull()
    const hiddenCard = hidden.closest('[data-remote-agent]') as HTMLElement
    expect(hiddenCard.querySelector('span[aria-hidden="true"].w-7')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Ledger helper settings' }))
    expect(ui.setActiveExternalAgentId).toHaveBeenCalledWith('shown')
    expect(ui.setAgentPageMode).toHaveBeenCalledWith('settings')
    expect(ui.setActiveView).toHaveBeenCalledWith('external-agent')
    fireEvent.click(hidden)
    expect(setVisible).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote' }), true, expect.any(Function))
  })

  it('puts Sync beside the section title and the explanation behind its (?)', () => {
    render(<AgentsSettingsSection />)
    const section = screen.getByRole('heading', { name: 'core.example.com' }).closest('section') as HTMLElement
    fireEvent.click(within(section).getByRole('button', { name: 'Sync' }))
    expect(sync).toHaveBeenCalledTimes(1)
    expect(within(section).getByRole('button', { name: 'About core.example.com' })).toBeTruthy()
    expect(section.textContent).not.toContain('Choose which agents')
  })

  it('names each switch by what it sets, the same whether the agent is shown or hidden, as the settings switch', () => {
    render(<AgentsSettingsSection />)
    const hidden = screen.getByRole('switch', { name: 'Show Cinna agent in Desktop' })
    const shown = screen.getByRole('switch', { name: 'Show Ledger helper in Desktop' })
    expect([hidden.getAttribute('aria-checked'), shown.getAttribute('aria-checked')]).toEqual(['false', 'true'])
    // Named by a <label for>, not an aria-label that flips with the state.
    for (const control of [hidden, shown]) {
      expect(control.hasAttribute('aria-label')).toBe(false)
      expect(document.querySelector(`label[for="${control.id}"]`)?.className).toContain('sr-only')
    }
  })

  it('puts a failed sync last in the section, under the agents, so their switches stay put', () => {
    state.syncError = 'failed'
    render(<AgentsSettingsSection />)
    const section = screen.getByRole('heading', { name: 'core.example.com' }).closest('section') as HTMLElement
    const banner = within(section).getByText(/Remote agent sync failed/)
    const lastCard = within(section).getByRole('switch', { name: 'Show Ledger helper in Desktop' }).closest('[data-remote-agent]')!
    expect(lastCard.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('lets the description give way before the name', () => {
    render(<AgentsSettingsSection />)
    const name = screen.getByText('Ledger helper')
    expect(name.className).not.toContain('shrink-0')
    expect(name.className).toContain('truncate')
    expect(screen.getByText('Reads the ledger').className).toContain('shrink-[1000]')
  })

  it('shows a refused change last in that agent’s card', () => {
    setVisible.mockImplementation((_agent: unknown, _visible: boolean, onError: (err: unknown) => void) => onError(new Error('Server said no.')))
    render(<AgentsSettingsSection />)
    fireEvent.click(screen.getByRole('switch', { name: 'Show Ledger helper in Desktop' }))
    const card = screen.getByRole('switch', { name: 'Show Ledger helper in Desktop' }).closest('[data-remote-agent]') as HTMLElement
    expect(card.lastElementChild?.getAttribute('role')).toBe('alert')
    expect(card.lastElementChild?.textContent).toBe('Server said no.')
  })
})
