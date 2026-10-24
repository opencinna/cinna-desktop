import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
const mutateAsync = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useMcp', () => ({
  useMcpRegistries: () => ({ data: [{ id: 'official', label: 'MCP Official' }] }),
  useMcpRegistrySearchAll: () => ({
    isLoading: false,
    data: {
      errors: [],
      entries: [{ registryId: 'official', id: 'ledger', name: 'ledger', title: 'Ledger', remotes: [{ type: 'streamable-http', url: 'https://ledger.example/mcp' }] }]
    }
  }),
  useUpsertMcpProvider: () => ({ mutateAsync, isPending: false })
}))
import { MCPRegistryPicker } from './MCPRegistryPicker'

it('keeps the picker open and says why on the row when main refuses the add', async () => {
  mutateAsync.mockRejectedValueOnce(new Error('Your admin turned off public MCP directories.'))
  const onClose = vi.fn()
  const onCreated = vi.fn()
  render(<MCPRegistryPicker onClose={onClose} onCreated={onCreated} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })) })
  expect(screen.getByRole('alert').textContent).toBe('Your admin turned off public MCP directories.')
  expect(onClose).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
})
