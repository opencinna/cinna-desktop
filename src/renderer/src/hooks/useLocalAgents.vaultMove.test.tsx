import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalAgentChangedPayload } from '../../../shared/localAgents'
import { useLocalAgentWatch } from './useLocalAgents'

/**
 * A move into or out of an Agent Vault changes what an open chat with the
 * agent may do (its `vaultReadiness` comes with the chat's detail): the push
 * main sends for the move refetches that agent's chats, and no other chat.
 */

let push: ((payload: LocalAgentChangedPayload) => void) | null = null

afterEach(() => {
  push = null
  delete (window as unknown as { api?: unknown }).api
})

function Probe(): null {
  useLocalAgentWatch()
  return null
}

function setup(): QueryClient {
  ;(window as unknown as { api: unknown }).api = { localAgents: { onChanged: (fn: typeof push) => { push = fn; return () => {} } } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['chat', 'with-agent'], { id: 'with-agent', agentId: 'folder:a', messages: [] })
  client.setQueryData(['chat', 'other'], { id: 'other', agentId: 'folder:b', messages: [] })
  render(createElement(QueryClientProvider, { client }, createElement(Probe)))
  return client
}

const stale = (client: QueryClient, id: string): boolean | undefined => client.getQueryState(['chat', id])?.isInvalidated

describe('useLocalAgentWatch on a vault move', () => {
  it('refetches the moved agent\'s chats only', () => {
    const client = setup()
    act(() => push!({ rootId: 'r', agentId: 'folder:a', reason: 'vault' }))
    expect(stale(client, 'with-agent')).toBe(true)
    expect(stale(client, 'other')).toBe(false)
  })

  it('leaves chats alone on an ordinary folder change', () => {
    const client = setup()
    act(() => push!({ rootId: 'r', agentId: 'folder:a', reason: 'watch' }))
    expect(stale(client, 'with-agent')).toBe(false)
  })
})

/**
 * Main re-resolved every agent because the Default runtime or the credentials
 * moved: the Default runtime's own answer (`staleTime: Infinity`, the label of
 * the Runs-on option) is refetched with them, and only then.
 */
describe('useLocalAgentWatch when the runtime defaults move', () => {
  const defaultRuntimeStale = (client: QueryClient): boolean | undefined => client.getQueryState(['default-runtime'])?.isInvalidated

  it('refetches the Default runtime', () => {
    const client = setup()
    client.setQueryData(['default-runtime'], { engine: 'claude' })
    act(() => push!({ rootId: 'r', agentId: null, reason: 'runtime-defaults' }))
    expect(defaultRuntimeStale(client)).toBe(true)
  })

  it('leaves it alone on a folder change', () => {
    const client = setup()
    client.setQueryData(['default-runtime'], { engine: 'claude' })
    act(() => push!({ rootId: 'r', agentId: null, reason: 'watch' }))
    expect(defaultRuntimeStale(client)).toBe(false)
  })
})
