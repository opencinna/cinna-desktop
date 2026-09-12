import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
vi.mock('../../hooks/useMcp', () => ({
  useUpsertMcpProvider: () => ({ mutate: vi.fn() }), useDeleteMcpProvider: () => ({ mutate: vi.fn() }),
  useConnectMcp: () => ({ mutate: vi.fn() }), useDisconnectMcp: () => ({ mutate: vi.fn() })
}))
vi.mock('../ui/AnimatedCollapse', () => ({ AnimatedCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null }))
import { MCPProviderCard } from './MCPProviderCard'
it('keeps Transport available when moving from stdio to SSE and back', () => {
  render(<MCPProviderCard provider={{ id: 'mcp', name: 'Test MCP', transportType: 'stdio',
    enabled: true, hasAuth: false, authType: 'oauth', status: 'disconnected', tools: [] }} />)
  fireEvent.click(screen.getByText('Test MCP'))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sse' } })
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('sse')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'stdio' } })
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('stdio')
})
