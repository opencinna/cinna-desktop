import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which router the in-chat `@`-agent gesture asks for.
 *
 * Every plain chat is rooted on its own hidden runtime, so "has a root" no
 * longer means "has an agent the user picked". Reading it that way turned the
 * commonest chat into a You-route chat with the hidden runtime as a participant.
 */

const spies = vi.hoisted(() => ({
  setRouter: vi.fn(async () => ({ success: true })),
  addOnDemandAgent: vi.fn(async () => ({ success: true }))
}))

;(window as unknown as { api: unknown }).api = new Proxy({}, {
  get: (_t, ns: string) => new Proxy({}, {
    get: (_n, method: string) => {
      if (ns === 'chat' && method === 'setRouter') return spies.setRouter
      if (ns === 'chat' && method === 'addOnDemandAgent') return spies.addOnDemandAgent
      if (ns === 'settings' && method === 'getAll') return async () => ({ defaultMultiAgentRouting: 'human' })
      return method.startsWith('on') ? () => () => undefined : async () => []
    }
  })
})

const { useAttachAgentToChat } = await import('./useAgents')

function attach(root: { id: string; conductor?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['chat', 'chat-1'], { id: 'chat-1', router: 'direct', agentId: root.id })
  client.setQueryData(['agents'], [root, { id: 'specialist' }])
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useAttachAgentToChat('chat-1'), { wrapper })
}

beforeEach(() => { spies.setRouter.mockClear(); spies.addOnDemandAgent.mockClear() })

describe('useAttachAgentToChat', () => {
  it('keeps a plain chat’s hidden runtime answering: the agent becomes its tool', async () => {
    const { result } = attach({ id: 'runtime', conductor: true })
    await act(() => result.current('specialist'))
    expect(spies.setRouter).toHaveBeenCalledWith('chat-1', 'coordinator')
    expect(spies.addOnDemandAgent).toHaveBeenCalledWith('chat-1', 'specialist')
  })

  it('still hands a chat with a picked agent to the user under You route', async () => {
    const { result } = attach({ id: 'picked' })
    await act(() => result.current('specialist'))
    expect(spies.setRouter).toHaveBeenCalledWith('chat-1', 'human')
  })
})
