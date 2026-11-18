import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStatusDto } from '../../../../shared/vault/types'
import { vaultStatusKey } from '../../hooks/useVault'

/**
 * A vault agent's chip menu: no Open Agent Folder / Open Uploads (its folder
 * is inside the VM, so they could only fail), and Lock now while its vault is
 * unlocked.
 */

const folders = vi.hoisted(() => ({ agents: [] as unknown[] }))
vi.mock('../../hooks/useLocalAgents', () => ({
  useLocalAgents: () => ({ data: { agents: folders.agents, errors: [] } }),
  useOpenAgentPath: () => ({ mutateAsync: vi.fn() }),
  useOpenAgentUploads: () => ({ mutateAsync: vi.fn() }),
  LOCAL_AGENTS_KEY: ['local-agents'],
  localAgentKey: (id: string) => ['local-agent', id]
}))

const lock = vi.fn(async (_agentId: string): Promise<unknown> => ({ ok: true, data: {} }))
const { AgentChip } = await import('./AgentChip')

function status(state: VaultStatusDto['state']): VaultStatusDto {
  return {
    agentId: 'folder:v', vaultId: 'v1', agentName: 'Ledger', engine: 'claude', state, until: null,
    lockAfterMs: 300_000, sizeBytes: 0, usedBytes: null, egress: { hosts: [] }, createdAt: 0, imageVersion: '', error: null, otherBuild: null
  }
}

function openMenu(agent: { id: string; name: string; source: string }, vault: VaultStatusDto | null): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  if (vault) client.setQueryData(vaultStatusKey(agent.id), vault)
  render(
    <QueryClientProvider client={client}>
      <AgentChip name={agent.name} label={agent.name} colors={{ border: 'red', bg: 'blue' }} menu={{ agent }} />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: agent.name }))
}

beforeEach(() => {
  lock.mockClear()
  Object.assign(window, { api: { vault: { lock, status: vi.fn() } } })
})

describe('agent chip menu', () => {
  it('offers the folder items for an ordinary folder agent, and no Lock now', () => {
    folders.agents = [{ id: 'folder:a', name: 'Alpha' }]
    openMenu({ id: 'folder:a', name: 'Alpha', source: 'folder' }, null)
    expect(screen.getByRole('menuitem', { name: 'Open Agent Folder' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Open Uploads' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Lock Now' })).toBeNull()
  })

  it('hides the folder items of a vault agent and locks its unlocked vault', async () => {
    folders.agents = [{ id: 'folder:v', name: 'Ledger', vault: { vaultId: 'v1', state: 'unlocked', engine: 'claude' } }]
    openMenu({ id: 'folder:v', name: 'Ledger', source: 'vault' }, status('unlocked'))
    expect(screen.queryByRole('menuitem', { name: 'Open Agent Folder' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open Uploads' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Go to Agent' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lock Now' }))
    await waitFor(() => expect(lock).toHaveBeenCalledWith('folder:v'))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('offers no Lock now while the vault is locked', () => {
    folders.agents = [{ id: 'folder:v', name: 'Ledger', vault: { vaultId: 'v1', state: 'locked', engine: 'claude' } }]
    openMenu({ id: 'folder:v', name: 'Ledger', source: 'vault' }, status('locked'))
    expect(screen.queryByRole('menuitem', { name: 'Lock Now' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open Agent Folder' })).toBeNull()
  })

  it('keeps the menu open with the reason when the lock fails', async () => {
    lock.mockResolvedValueOnce({ ok: false, code: 'internal', message: 'The vault helper exited.' })
    folders.agents = [{ id: 'folder:v', name: 'Ledger', vault: { vaultId: 'v1', state: 'unlocked', engine: 'claude' } }]
    openMenu({ id: 'folder:v', name: 'Ledger', source: 'vault' }, status('unlocked'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lock Now' }))
    expect(await screen.findByText(/The vault helper exited\./)).toBeTruthy()
    expect(screen.getByRole('menu')).toBeTruthy()
  })
})
