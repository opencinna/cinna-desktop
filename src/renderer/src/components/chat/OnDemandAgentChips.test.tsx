import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OnDemandAgentChips } from './OnDemandAgentChips'

vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({ data: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] }),
  useChatOnDemandAgents: () => ({ data: [] }),
  useRemoveOnDemandAgent: () => ({ mutateAsync: vi.fn() })
}))

describe('new-chat coordination chips', () => {
  it('labels the first local coordinator without changing selected order', () => {
    const view = render(<OnDemandAgentChips pendingIds={['b', 'a']} onRemovePending={vi.fn()} />)
    const names = () => screen.getAllByRole('button', { name: /Remove agent/ }).map((button) => button.getAttribute('aria-label'))
    const before = names()
    view.rerender(<OnDemandAgentChips pendingIds={['b', 'a']} onRemovePending={vi.fn()} coordination={{ conductorId: 'b', conductorName: 'Beta' }} />)
    expect(names()).toEqual(before)
    expect(screen.getByText('Coordinator').parentElement?.title).toBe('Beta — Coordinator')
    expect(screen.getByText('Participant').parentElement?.title).toBe('Alpha — Participant')
    expect(screen.getByText('Coordinator').parentElement?.className).toContain('ring-2')
  })

  it('shows a non-removable Default runtime coordinator for remote-first selection', () => {
    render(<OnDemandAgentChips pendingIds={['a', 'b']} onRemovePending={vi.fn()} coordination={{ conductorId: null, conductorName: 'Default runtime' }} />)
    expect(screen.getByText('Default runtime')).toBeTruthy()
    expect(screen.getAllByText('Participant')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Remove agent Default runtime' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /Remove agent/ }).map((button) => button.getAttribute('aria-label'))).toEqual(['Remove agent Alpha', 'Remove agent Beta'])
  })
})
