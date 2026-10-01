import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UseMutationResult } from '@tanstack/react-query'

const users = vi.hoisted(() => ({ current: { isPending: false, isError: false, data: [] as { id: string; name: string }[] } }))
vi.mock('../../hooks/useMcp', () => ({
  useMcpAgentsUsing: () => users.current,
  useUpsertMcpProvider: () => ({ mutate: vi.fn() }), useConnectMcp: () => ({ mutate: vi.fn() }),
  useDisconnectMcp: () => ({ mutate: vi.fn() }), useDeleteMcpProvider: () => deleteMutation
}))
const deleteMutation = { mutate: vi.fn(), isPending: false }
import { DeleteMcpProviderDialog } from './DeleteMcpProviderDialog'
import { MCPProviderCard } from './MCPProviderCard'

/**
 * Deleting a connector cascades to every folder agent it is attached to, on a
 * page the user is not looking at — so the confirm names them (ux_rules rule 5).
 */

type Remove = UseMutationResult<{ success: boolean }, Error, string>
const remove = (over: Partial<Remove> = {}): Remove => ({ mutate: vi.fn(), isPending: false, ...over }) as unknown as Remove
const provider = { id: 'gh', name: 'GitHub' }

beforeEach(() => {
  users.current = { isPending: false, isError: false, data: [] }
  deleteMutation.mutate.mockClear()
})

describe('DeleteMcpProviderDialog', () => {
  it('names the agents that lose the connector', () => {
    users.current.data = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
    render(<DeleteMcpProviderDialog provider={provider} remove={remove()} onCancel={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Delete MCP connector' })).toBeTruthy()
    expect(screen.getByText('Alpha, Beta')).toBeTruthy()
    expect(screen.getByText(/it will be removed from them/)).toBeTruthy()
  })

  it('says nothing about agents when none use it', () => {
    render(<DeleteMcpProviderDialog provider={provider} remove={remove()} onCancel={vi.fn()} />)
    expect(screen.queryByText(/Used by/)).toBeNull()
  })

  it('waits for the lookup before showing anything', () => {
    users.current = { isPending: true, isError: false, data: [] }
    render(<DeleteMcpProviderDialog provider={provider} remove={remove()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('deletes only on confirm, and stays put while deleting', () => {
    const onCancel = vi.fn()
    const { rerender } = render(<DeleteMcpProviderDialog provider={provider} remove={remove()} onCancel={onCancel} />)
    const pending = remove({ isPending: true })
    rerender(<DeleteMcpProviderDialog provider={provider} remove={pending} onCancel={onCancel} />)
    expect(screen.getByRole('button', { name: 'Deleting…' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('opens from the card’s trash button instead of deleting at once', () => {
    users.current.data = [{ id: 'a', name: 'Alpha' }]
    render(<MCPProviderCard provider={{ id: 'gh', name: 'GitHub', transportType: 'stdio', enabled: true, hasAuth: false,
      authType: 'oauth', status: 'connected', tools: [] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete MCP GitHub' }))
    expect(deleteMutation.mutate).not.toHaveBeenCalled()
    expect(screen.getByText(/it will be removed from it\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleteMutation.mutate).toHaveBeenCalledWith('gh', expect.anything())
  })

  it('offers Detach instead of Delete on an agent’s addon row, without expanding it', () => {
    const onDetach = vi.fn()
    render(<MCPProviderCard detach={{ onDetach }} provider={{ id: 'gh', name: 'GitHub', transportType: 'stdio', enabled: true,
      hasAuth: false, authType: 'oauth', status: 'connected', tools: [] }} />)
    expect(screen.queryByRole('button', { name: 'Delete MCP GitHub' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Detach GitHub from this agent' }))
    expect(onDetach).toHaveBeenCalledOnce()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(deleteMutation.mutate).not.toHaveBeenCalled()
  })
})
