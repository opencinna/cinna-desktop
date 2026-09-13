import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * What `startNewChat` writes before the first message goes out.
 *
 * Two things it decides that nothing downstream can correct: the **router** the
 * chat is created on, and the **scope** its attachments are ingested under.
 *
 * The scope is the one that bites. It used to be read off the routing decision
 * as `router !== 'coordinator' ? 'cinna' : 'local'` — which is not the same
 * question, because a chat with no agent at all is `direct`, to the local
 * model, and its files belong in the local store. Sending them to the Cinna
 * backend instead throws for an account that has none, and the catch deletes
 * the chat row: attachments stop working in the commonest chat in the app, and
 * take the chat with them.
 */

const spies = vi.hoisted(() => ({
  createChat: vi.fn(async () => ({ id: 'chat-1' })),
  listChats: vi.fn(async (): Promise<{ id: string }[]> => []),
  listTrash: vi.fn(async (): Promise<{ id: string }[]> => []),
  updateChat: vi.fn(async () => ({ success: true })),
  ingestPaths: vi.fn(async () => ({ success: true, files: [{ id: 'f1', filename: 'a.pdf' }] })),
  addOnDemandAgent: vi.fn(async () => ({ success: true })),
  addOnDemandMcp: vi.fn(async () => ({ success: true })),
  setMcpProviders: vi.fn(async () => ({ success: true })),
  deleteChat: vi.fn(async () => ({ success: true })),
  runSend: vi.fn().mockResolvedValue('run-1')
}))

function namespace(methods: Record<string, unknown>): unknown {
  return new Proxy(methods, {
    get: (target, method: string) =>
      method in target
        ? target[method]
        : method.startsWith('on')
          ? () => () => undefined
          : async () => []
  })
}

;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'chat') {
        return namespace({
          create: spies.createChat,
          list: spies.listChats,
          trashList: spies.listTrash,
          update: spies.updateChat,
          delete: spies.deleteChat,
          addOnDemandAgent: spies.addOnDemandAgent,
          addOnDemandMcp: spies.addOnDemandMcp,
          setMcpProviders: spies.setMcpProviders
        })
      }
      if (ns === 'files') return namespace({ ingestPaths: spies.ingestPaths })
      if (ns === 'run') return namespace({ start: spies.runSend, cancel: () => undefined })
      return namespace({})
    }
  }
)

const { useNewChatFlow } = await import('./useNewChatFlow')
const { useChatList, useTrashList } = await import('./useChat')
const { useChatStore } = await import('../stores/chat.store')
const { useAuthStore } = await import('../stores/auth.store')

const PENDING = [{ id: '/tmp/a.pdf', source: 'pending' as const, filename: 'a.pdf' }]

function queryWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
}

function renderFlow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return renderHook(() => useNewChatFlow(), { wrapper: queryWrapper(client) })
}

const chatOptions = (over: Record<string, unknown> = {}) => ({
  message: 'hello',
  agentIds: [],
  mode: null,
  providerId: 'p-1',
  providers: [{ id: 'p-1', defaultModelId: 'm-1' }] as never,
  allModels: [{ id: 'm-1', providerId: 'p-1' }] as never,
  mcpIds: [],
  ...over
} as Parameters<ReturnType<typeof useNewChatFlow>['startNewChat']>[0])

async function start(over: Record<string, unknown>): Promise<void> {
  const { result } = renderFlow()
  await act(async () => {
    await result.current.startNewChat(chatOptions(over))
  })
}

/** The `router` the chat row was created on. */
const writtenRouter = (): string =>
  (spies.updateChat.mock.calls.at(-1) as unknown as [string, { router: string }])[1].router

/** The scope the pending attachment was ingested under. */
const ingestScope = (): string =>
  (spies.ingestPaths.mock.calls.at(-1) as unknown as [{ scope: string }])[0].scope

beforeEach(() => {
  vi.clearAllMocks()
  spies.listChats.mockResolvedValue([])
  spies.listTrash.mockResolvedValue([])
  useChatStore.getState().reset()
  useAuthStore.getState().setCurrentUser({ id: 'account-1', type: 'local', username: 'one', displayName: 'One', hasPassword: false })
})

describe('startNewChat — the router it creates the chat on', () => {
  it('is direct for a plain chat with the local model', async () => {
    await start({ agentIds: [] })
    expect(writtenRouter()).toBe('direct')
  })

  it('is direct for one agent, and binds it as the root', async () => {
    await start({ agentIds: ['a-1'] })
    expect(writtenRouter()).toBe('direct')
    expect((spies.updateChat.mock.calls.at(-1) as never as [string, { agentId?: string }])[1].agentId).toBe('a-1')
    // A bound root is the chat's own counterparty, not one of its attached.
    expect(spies.addOnDemandAgent).not.toHaveBeenCalled()
  })

  it('is human for several agents, with all of them attached and none bound', async () => {
    await start({ agentIds: ['a-1', 'a-2'] })
    expect(writtenRouter()).toBe('human')
    expect((spies.updateChat.mock.calls.at(-1) as never as [string, { agentId?: string }])[1].agentId).toBeUndefined()
    expect(spies.addOnDemandAgent).toHaveBeenCalledTimes(2)
  })

  it('is coordinator once an agent is mixed with an MCP server', async () => {
    await start({ agentIds: ['a-1'], onDemandMcpIds: ['mcp-1'] })
    expect(writtenRouter()).toBe('coordinator')
  })
})

describe('startNewChat — where the attachments go', () => {
  it('ingests a plain model chat’s files into the local store', async () => {
    // Reading this off `router !== 'coordinator'` sent them to the Cinna
    // backend, where an account that has none throws — and the catch deletes
    // the chat row on the way out.
    await start({ agentIds: [], attachments: PENDING })
    expect(ingestScope()).toBe('local')
    expect(spies.deleteChat).not.toHaveBeenCalled()
  })

  it('ingests a direct agent chat’s files to the Cinna backend', async () => {
    await start({ agentIds: ['a-1'], attachments: PENDING })
    expect(ingestScope()).toBe('cinna')
  })

  it('ingests a human chat’s files to the Cinna backend too', async () => {
    await start({ agentIds: ['a-1', 'a-2'], attachments: PENDING })
    expect(ingestScope()).toBe('cinna')
  })

  it('ingests a coordinated chat’s files into the local store', async () => {
    await start({ agentIds: ['a-1'], onDemandMcpIds: ['mcp-1'], attachments: PENDING })
    expect(ingestScope()).toBe('local')
  })
})

describe('startNewChat — the first message', () => {
  it('addresses the first agent picked in a human chat', async () => {
    await start({ agentIds: ['a-2', 'a-1'] })
    expect(spies.runSend.mock.calls[0][0]).toMatchObject({ addressedAgentId: 'a-2' })
  })

  it('names no agent in a coordinated chat', async () => {
    await start({ agentIds: ['a-1'], onDemandMcpIds: ['mcp-1'] })
    const extras = spies.runSend.mock.calls[0][0] as { addressedAgentId?: string | null }
    expect(extras.addressedAgentId ?? null).toBeNull()
  })
})


describe('startNewChat — guarded creation lifecycle', () => {
  it.each([
    { switchAccount: false, deletedSuccess: true },
    { switchAccount: true, deletedSuccess: true },
    { switchAccount: false, deletedSuccess: false }
  ])('refreshes orphan cleanup queries only after successful same-account deletion (switch: $switchAccount, success: $deletedSuccess)', async ({ switchAccount, deletedSuccess }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    let rows: { id: string }[] = []
    let trash: { id: string }[] = []
    spies.listChats.mockImplementation(async () => rows)
    spies.listTrash.mockImplementation(async () => trash)
    let current = true
    spies.createChat.mockImplementationOnce(async () => {
      rows = [{ id: 'chat-1' }]
      current = false
      return rows[0]
    })
    let resolveDelete!: (result: { success: boolean }) => void
    spies.deleteChat.mockImplementationOnce(() => new Promise((resolve) => { resolveDelete = resolve }))
    // Observe the same production queries the sidebar/trash use, including
    // the creation refetch that can finish before orphan cleanup completes.
    const { result } = renderHook(() => ({
      ...useNewChatFlow(), chats: useChatList(), trash: useTrashList()
    }), { wrapper: queryWrapper(client) })
    await waitFor(() => {
      expect(result.current.chats.data).toEqual([])
      expect(result.current.trash.data).toEqual([])
    })
    let pending!: Promise<void>
    act(() => {
      pending = result.current.startNewChat(chatOptions({ isCurrent: () => current }))
    })
    await waitFor(() => {
      expect(spies.deleteChat).toHaveBeenCalledWith('chat-1')
      expect(result.current.chats.data).toEqual([{ id: 'chat-1' }])
    })
    invalidate.mockClear()
    await act(async () => {
      if (switchAccount) {
        useAuthStore.getState().setCurrentUser({ id: 'account-2', type: 'local', username: 'two', displayName: 'Two', hasPassword: false })
        client.setQueryData(['chats'], [{ id: 'account-2-chat' }])
      }
      if (deletedSuccess) {
        rows = []
        trash = [{ id: 'chat-1' }]
      }
      resolveDelete({ success: deletedSuccess })
      await pending
    })
    if (switchAccount || !deletedSuccess) {
      expect(invalidate).not.toHaveBeenCalled()
      expect(client.getQueryData(['chats'])).toEqual([{ id: switchAccount ? 'account-2-chat' : 'chat-1' }])
      expect(client.getQueryData(['trash'])).toEqual([])
    } else {
      await waitFor(() => {
        expect(result.current.chats.data).toEqual([])
        expect(result.current.trash.data).toEqual([{ id: 'chat-1' }])
      })
    }
  })

  it.each(['navigation', 'unmount'])('cleans up a same-account orphan after %s during creation without changing the selected chat', async (reason) => {
    let resolveCreate!: (chat: { id: string }) => void
    spies.createChat.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve }))
    const { result, unmount } = renderFlow()
    let current = true
    let pending!: Promise<void>
    act(() => {
      pending = result.current.startNewChat(chatOptions({ agentIds: ['builder'], isCurrent: () => current }))
    })
    await waitFor(() => expect(spies.createChat).toHaveBeenCalled())
    await act(async () => {
      current = false
      if (reason === 'unmount') unmount()
      useChatStore.getState().setActiveChatId('other-chat')
      resolveCreate({ id: 'chat-1' })
      await pending
    })
    expect(spies.updateChat).not.toHaveBeenCalled()
    expect(spies.runSend).not.toHaveBeenCalled()
    expect(spies.deleteChat).toHaveBeenCalledWith('chat-1')
    expect(useChatStore.getState().activeChatId).toBe('other-chat')
    expect(useChatStore.getState().sendError).toBeNull()
  })

  it('does not select, delete, update, or send to a created chat after switching accounts', async () => {
    let resolveCreate!: (chat: { id: string }) => void
    spies.createChat.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve }))
    const { result } = renderFlow()
    let pending!: Promise<void>
    act(() => {
      pending = result.current.startNewChat(chatOptions({
        agentIds: ['builder'],
        // Account identity is protected independently of the page guard.
        isCurrent: () => true
      }))
    })
    await waitFor(() => expect(spies.createChat).toHaveBeenCalled())
    await act(async () => {
      useAuthStore.getState().setCurrentUser({ id: 'account-2', type: 'local', username: 'two', displayName: 'Two', hasPassword: false })
      useChatStore.getState().setActiveChatId('account-2-chat')
      resolveCreate({ id: 'chat-1' })
      await pending
    })
    expect(spies.updateChat).not.toHaveBeenCalled()
    expect(spies.runSend).not.toHaveBeenCalled()
    expect(spies.deleteChat).not.toHaveBeenCalled()
    expect(useChatStore.getState().activeChatId).toBe('account-2-chat')
    expect(useChatStore.getState().sendError).toBeNull()
  })

  it.each([false, true])('defers selection through preparation only for a guarded flow (%s)', async (guarded) => {
    let resolveUpdate!: (result: { success: boolean }) => void
    spies.updateChat.mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve }))
    const { result } = renderFlow()
    let pending!: Promise<void>
    act(() => {
      useChatStore.getState().setActiveChatId('previous-chat')
      pending = result.current.startNewChat(chatOptions({ isCurrent: guarded ? () => true : undefined }))
    })
    await waitFor(() => expect(spies.updateChat).toHaveBeenCalled())
    expect(useChatStore.getState().activeChatId).toBe(guarded ? 'previous-chat' : 'chat-1')
    expect(spies.runSend).not.toHaveBeenCalled()
    await act(async () => {
      resolveUpdate({ success: true })
      await pending
    })
    expect(useChatStore.getState().activeChatId).toBe('chat-1')
    expect(spies.runSend).toHaveBeenCalledTimes(1)
    expect(spies.deleteChat).not.toHaveBeenCalled()
  })
})
