import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act } from '@testing-library/react'
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
  updateChat: vi.fn(async () => ({ success: true })),
  ingestPaths: vi.fn(async () => ({ success: true, files: [{ id: 'f1', filename: 'a.pdf' }] })),
  addOnDemandAgent: vi.fn(async () => ({ success: true })),
  addOnDemandMcp: vi.fn(async () => ({ success: true })),
  setMcpProviders: vi.fn(async () => ({ success: true })),
  deleteChat: vi.fn(async () => ({ success: true })),
  runSend: vi.fn()
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
          update: spies.updateChat,
          delete: spies.deleteChat,
          addOnDemandAgent: spies.addOnDemandAgent,
          addOnDemandMcp: spies.addOnDemandMcp,
          setMcpProviders: spies.setMcpProviders
        })
      }
      if (ns === 'files') return namespace({ ingestPaths: spies.ingestPaths })
      if (ns === 'run') return namespace({ send: spies.runSend, cancel: () => undefined })
      return namespace({})
    }
  }
)

const { useNewChatFlow } = await import('./useNewChatFlow')
const { useChatStore } = await import('../stores/chat.store')

const PENDING = [{ id: '/tmp/a.pdf', source: 'pending' as const, filename: 'a.pdf' }]

async function start(over: Record<string, unknown>): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useNewChatFlow(), { wrapper })
  await act(async () => {
    await result.current.startNewChat({
      message: 'hello',
      agentIds: [],
      mode: null,
      providerId: 'p-1',
      providers: [{ id: 'p-1', defaultModelId: 'm-1' }] as never,
      allModels: [{ id: 'm-1', providerId: 'p-1' }] as never,
      mcpIds: [],
      ...over
    } as never)
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
  useChatStore.getState().reset()
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
    expect(spies.runSend.mock.calls[0][3]).toMatchObject({ addressedAgentId: 'a-2' })
  })

  it('names no agent in a coordinated chat', async () => {
    await start({ agentIds: ['a-1'], onDemandMcpIds: ['mcp-1'] })
    const extras = spies.runSend.mock.calls[0][3] as { addressedAgentId?: string | null }
    expect(extras.addressedAgentId ?? null).toBeNull()
  })
})
