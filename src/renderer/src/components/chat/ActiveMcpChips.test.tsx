import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

vi.mock('../../hooks/useMcp', () => ({
  useMcpProviders: () => ({ data: ['mode', 'gh', 'mine'].map((id) => ({ id, name: id.toUpperCase(), status: 'connected' })) }),
  useChatOnDemandMcps: () => ({ data: [{ mcpProviderId: 'mine' }, { mcpProviderId: 'gh' }] }),
  useRemoveOnDemandMcp: () => ({ mutateAsync: vi.fn() })
}))
import { ActiveMcpChips } from './ActiveMcpChips'

it('draws the bound agent’s addons locked, after the baseline and once each', () => {
  render(<ActiveMcpChips chatId="c1" baselineIds={['mode']} agentAddonIds={['gh']} agentName="Alpha" />)
  const chips = screen.getAllByText(/^(MODE|GH|MINE)$/).map((chip) => chip.textContent)
  expect(chips).toEqual(['MODE', 'GH', 'MINE'])
  expect(screen.getByTitle(/MCP "GH" comes with the agent Alpha/)).toBeTruthy()
  // Only the user's own engagement can be removed here.
  expect(screen.queryByRole('button', { name: 'Remove MCP GH from this chat' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove MCP MODE from this chat' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Remove MCP MINE from this chat' })).toBeTruthy()
})
