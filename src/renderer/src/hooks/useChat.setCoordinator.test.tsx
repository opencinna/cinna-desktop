import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it } from 'vitest'
import { useSetChatCoordinator } from './useChat'

/**
 * The optimistic move of "Set as Coordinator": the old root rejoins the
 * attached chips only when it is known to be an agent the user picked. The
 * hidden runtime never does, so an old root the agents cache cannot vouch for
 * waits for main's answer instead of flashing up as a participant.
 */

afterEach(() => cleanup())

function setup(agents: unknown[] | undefined): QueryClient {
  // Main never answers: what the chips show is the optimistic state alone.
  ;(window as unknown as { api: unknown }).api = { chat: { setCoordinator: () => new Promise(() => undefined) } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  client.setQueryData(['chat', 'chat-1'], { id: 'chat-1', router: 'coordinator', agentId: 'old-root' })
  client.setQueryData(['chat-on-demand-agent', 'chat-1'], [{ agentId: 'next', pendingAnnounce: false }])
  if (agents) client.setQueryData(['agents'], agents)
  return client
}

async function setCoordinator(client: QueryClient): Promise<unknown> {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const view = renderHook(() => useSetChatCoordinator(), { wrapper })
  await act(async () => {
    view.result.current.mutate({ chatId: 'chat-1', agentId: 'next' })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return client.getQueryData(['chat-on-demand-agent', 'chat-1'])
}

it('moves a picked old root to the attached set, announced, as main writes it', async () => {
  const client = setup([{ id: 'old-root' }, { id: 'next' }])
  expect(await setCoordinator(client)).toEqual([{ agentId: 'old-root', pendingAnnounce: true }])
  expect(client.getQueryData<{ agentId: string }>(['chat', 'chat-1'])?.agentId).toBe('next')
})

it('never attaches the hidden runtime', async () => {
  const client = setup([{ id: 'old-root', conductor: true }, { id: 'next' }])
  expect(await setCoordinator(client)).toEqual([])
})

it('attaches nothing when the agents cache cannot say what the old root is', async () => {
  expect(await setCoordinator(setup(undefined))).toEqual([])
  expect(await setCoordinator(setup([{ id: 'next' }]))).toEqual([])
})
