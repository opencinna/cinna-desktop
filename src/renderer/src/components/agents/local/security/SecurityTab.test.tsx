import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'

/**
 * The Security tab's Permissions section: the card under it carries no title
 * of its own (the section is the title), and for an agent in a vault the
 * sentence that delegation is off lives behind the section's (?), not as a
 * standing line in the card.
 */

vi.mock('./AgentVaultSection', () => ({ AgentVaultSection: () => createElement('div', null, 'vault-section') }))
vi.mock('../PermissionsCard', () => ({
  PermissionsCard: (props: Record<string, unknown>) =>
    createElement('div', { 'data-props': Object.keys(props).sort().join(',') }, 'permissions-card')
}))

const { SecurityTab } = await import('./SecurityTab')

const agent = (over: Partial<LocalAgentDto> = {}): LocalAgentDto =>
  ({ id: 'folder:alpha', name: 'Alpha', path: '/tmp/alpha', kind: 'kit', ...over }) as LocalAgentDto
const OFF = /Delegation, handovers and cloud delegation are off in a vault/

describe('SecurityTab — Permissions', () => {
  it('names Permissions once, as the section; the card takes no title', () => {
    render(createElement(SecurityTab, { agent: agent() }))
    expect(screen.getByRole('heading', { name: 'Permissions' })).toBeTruthy()
    expect(screen.getByText('permissions-card').getAttribute('data-props')).toBe('agent')
  })

  it('says delegation is off in a vault behind the section’s (?)', () => {
    render(createElement(SecurityTab, { agent: agent({ vault: { vaultId: 'v1', state: 'locked', engine: 'claude' } }) }))
    expect(screen.queryByText(OFF)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About permissions' }))
    expect(screen.getByText(OFF)).toBeTruthy()
  })

  it('says nothing of a vault for an agent outside one', () => {
    render(createElement(SecurityTab, { agent: agent() }))
    fireEvent.click(screen.getByRole('button', { name: 'About permissions' }))
    expect(screen.getByText(/What this agent may do without asking you/)).toBeTruthy()
    expect(screen.queryByText(OFF)).toBeNull()
  })
})
