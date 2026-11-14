import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultStateEvent } from '../../../shared/vault/types'
import { useFilePreviewStore } from '../stores/filePreview.store'
import { LOCAL_AGENTS_KEY } from './useLocalAgents'
import { useVaultWatch } from './useVault'

/**
 * Where an agent's files can be reached changes with its vault: a state push,
 * or the agent list showing it moved into a vault, drops that agent's resolved
 * file references, and an open preview of one of its files checks again.
 */

let pushState: ((event: VaultStateEvent) => void) | null = null
const recheck = vi.fn(async () => {})

beforeEach(() => {
  pushState = null
  recheck.mockClear()
  useFilePreviewStore.setState({ recheckAgentFile: recheck })
  ;(window as unknown as { api: unknown }).api = {
    vault: {
      onState: (cb: (event: VaultStateEvent) => void) => {
        pushState = cb
        return () => {}
      }
    }
  }
})
afterEach(() => cleanup())

function mountWatch(client: QueryClient): void {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  renderHook(() => useVaultWatch(), { wrapper })
}

const snapshot = (agents: Array<{ id: string; vault?: object }>) => ({ roots: [], agents, homeAccess: null })
const isInvalidated = (client: QueryClient, agentId: string): boolean =>
  client.getQueryState(['agent-file-refs', agentId, '1:abc'])?.isInvalidated === true

function seedRefs(client: QueryClient, ...agentIds: string[]): void {
  for (const id of agentIds) client.setQueryData(['agent-file-refs', id, '1:abc'], [])
}

describe('file references and the vault', () => {
  it('drops an agent\'s resolved refs and rechecks its open preview on a state push', () => {
    const client = new QueryClient()
    seedRefs(client, 'folder:v', 'folder:other')
    mountWatch(client)
    act(() => pushState!({ agentId: 'folder:v', state: 'locked', until: null, error: null } as VaultStateEvent))
    expect(isInvalidated(client, 'folder:v')).toBe(true)
    expect(isInvalidated(client, 'folder:other')).toBe(false)
    expect(recheck).toHaveBeenCalledWith('folder:v')
  })

  it('acts only when the vault opens or closes, not on every window restart (a keystroke\'s touch, a turn\'s hold)', () => {
    const client = new QueryClient()
    seedRefs(client, 'folder:v')
    mountWatch(client)
    const push = (state: string, until: number | null): void =>
      act(() => pushState!({ agentId: 'folder:v', state, until, error: null } as VaultStateEvent))
    push('unlocked', 1)
    expect(recheck).toHaveBeenCalledTimes(1)
    seedRefs(client, 'folder:v')
    push('unlocked', 2)
    push('unlocked', null)
    expect(recheck).toHaveBeenCalledTimes(1)
    expect(isInvalidated(client, 'folder:v')).toBe(false)
    push('locked', null)
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(isInvalidated(client, 'folder:v')).toBe(true)
  })

  it('drops an agent\'s resolved refs once the agent list shows it moved into a vault, not on the first list', () => {
    const client = new QueryClient()
    seedRefs(client, 'folder:v', 'folder:other')
    mountWatch(client)
    act(() => client.setQueryData(LOCAL_AGENTS_KEY, snapshot([{ id: 'folder:v' }, { id: 'folder:other' }])))
    expect(isInvalidated(client, 'folder:v')).toBe(false)
    act(() => client.setQueryData(LOCAL_AGENTS_KEY, snapshot([{ id: 'folder:v', vault: {} }, { id: 'folder:other' }])))
    expect(isInvalidated(client, 'folder:v')).toBe(true)
    expect(isInvalidated(client, 'folder:other')).toBe(false)
  })
})
