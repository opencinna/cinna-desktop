import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredPermissionGrant } from '../../../shared/localAgentRequests'
import { localAgentGrantsKey } from './useLocalAgents'
import { useAgentGrants, useVaultForgetGrants, useVaultGrants, vaultDetailKey } from './useVault'

/**
 * A vault agent's *Always allow* grants: read from the vault under a vault key
 * of their own (never the folder agent's cache entry), and a vault refusal is
 * an answer, never retried into a long "Reading…".
 */

const grant = (key: string): StoredPermissionGrant =>
  ({ key, action: 'bash', pattern: 'ls', decidedAt: 1 }) as unknown as StoredPermissionGrant

const vault = {
  status: vi.fn(async (): Promise<unknown> => ({ ok: true, data: { state: 'unlocked' } })),
  grants: vi.fn(async (): Promise<unknown> => ({ ok: true, data: [grant('a')] })),
  forgetGrant: vi.fn(async (): Promise<unknown> => ({ ok: true, data: [] }))
}
const localAgents = { grantsList: vi.fn(async () => [grant('host')]) }

beforeEach(() => {
  vi.clearAllMocks()
  vault.grants.mockImplementation(async () => ({ ok: true, data: [grant('a')] }))
  ;(window as unknown as { api: unknown }).api = { vault, localAgents }
})
afterEach(() => cleanup())

/** `retry: 3` as the app's default, without the delay: a test about not retrying needs it on. */
function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
}
const retryingClient = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } })

describe('vault grants', () => {
  it('are cached under their own vault key, not the folder agent’s', async () => {
    const client = retryingClient()
    const { result } = renderHook(() => useVaultGrants('folder:alpha'), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.data).toEqual([grant('a')]))
    expect(client.getQueryData(vaultDetailKey('folder:alpha', 'grants'))).toEqual([grant('a')])
    expect(client.getQueryData(localAgentGrantsKey('folder:alpha'))).toBeUndefined()
  })

  it('writes what is left after a forget into the vault key only', async () => {
    const client = retryingClient()
    client.setQueryData(localAgentGrantsKey('folder:alpha'), [grant('host')])
    const { result } = renderHook(() => useVaultForgetGrants(), { wrapper: wrapperFor(client) })
    await act(async () => { await result.current.mutateAsync({ agentId: 'folder:alpha', key: 'a' }) })
    expect(client.getQueryData(vaultDetailKey('folder:alpha', 'grants'))).toEqual([])
    expect(client.getQueryData(localAgentGrantsKey('folder:alpha'))).toEqual([grant('host')])
  })

  it('asks once on a vault refusal (locked), not again', async () => {
    vault.grants.mockImplementation(async () => ({ ok: false, code: 'locked', message: 'The vault is locked.' }))
    const client = retryingClient()
    const { result } = renderHook(() => useVaultGrants('folder:alpha'), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.error).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vault.grants).toHaveBeenCalledTimes(1)
  })

  it('feeds the page’s grant count for a vault agent from the vault, and a host agent’s from its file', async () => {
    const client = retryingClient()
    const vaulted = { id: 'folder:alpha', vault: { vaultId: 'v1', state: 'unlocked', engine: 'claude', model: null } } as never
    const inVault = renderHook(() => useAgentGrants(vaulted).query, { wrapper: wrapperFor(client) })
    await waitFor(() => expect(inVault.result.current.data).toEqual([grant('a')]))
    const host = renderHook(() => useAgentGrants({ id: 'folder:beta' }).query, { wrapper: wrapperFor(client) })
    await waitFor(() => expect(host.result.current.data).toEqual([grant('host')]))
    expect(localAgents.grantsList).toHaveBeenCalledWith('folder:beta')
    expect(localAgents.grantsList).not.toHaveBeenCalledWith('folder:alpha')
  })
})
