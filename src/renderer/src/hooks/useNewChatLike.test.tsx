import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * New chat from the prompt-cache notice: the new-chat draft's routing fields
 * set up like the open chat, the rest of the draft left alone, nothing sent.
 */

interface Chat { id: string; agentId: string | null; router: 'direct' | 'human' | 'coordinator'; modeId: string | null }

const state = vi.hoisted(() => ({
  chat: null as unknown,
  agents: [] as unknown[],
  onDemandAgents: [] as { agentId: string; pendingAnnounce: boolean }[],
  onDemandMcps: [] as { mcpProviderId: string; pendingAnnounce: boolean }[],
  modes: [] as unknown[],
  prioritizeAccountDefaults: false,
  defaultRuntime: 'claude' as string
}))
const sends = vi.hoisted(() => vi.fn())

;(window as unknown as { api: unknown }).api = {
  chat: {
    get: async () => state.chat,
    listOnDemandAgents: async () => state.onDemandAgents,
    listOnDemandMcps: async () => state.onDemandMcps
  },
  agents: { list: async () => state.agents },
  chatModes: { list: async () => state.modes },
  settings: { getAll: async () => ({ prioritizeAccountDefaults: state.prioritizeAccountDefaults }) },
  engine: { defaultRuntime: async () => ({ engine: state.defaultRuntime }) },
  run: { start: sends }
}

const { useNewChatLike, chatDraftRouting, effectiveDefaultEngine } = await import('./useNewChatLike')
const { useComposerDraftStore, composerDraftKey, NEW_CHAT_DRAFT_SURFACE } = await import('../stores/composerDraft.store')
const { useChatStore } = await import('../stores/chat.store')

const USER_AGENTS = [{ id: 'invoices' }, { id: 'travel' }, { id: 'research' }]
const CONDUCTOR = { id: 'conductor:chat-1', conductor: true }
const CODEX_RUNTIME = { id: 'conductor:chat-1', conductor: true, conductorEngine: 'codex' as const }
/** The runtime modes main seeds, one per engine, plus a saved mode and an account's copy. */
interface Mode { id: string; builtinEngine: 'claude' | 'codex' | null; engine: 'claude' | 'codex' | null; managed: boolean; isDefault: boolean; enabled: boolean }
const mode = (id: string, builtinEngine: Mode['builtinEngine'], patch: Partial<Mode> = {}): Mode =>
  ({ id, builtinEngine, engine: builtinEngine, managed: false, isDefault: false, enabled: true, ...patch })
const MODES: Mode[] = [
  mode('rt-claude', 'claude'),
  mode('rt-codex-managed', 'codex', { managed: true }),
  mode('rt-codex', 'codex'),
  mode('writing', null)
]

function setChat(chat: Partial<Chat>, onDemandAgents: string[] = [], onDemandMcps: string[] = []): void {
  state.chat = { id: 'chat-1', agentId: null, router: 'direct', modeId: null, messages: [], ...chat }
  state.agents = [...USER_AGENTS, CONDUCTOR]
  state.onDemandAgents = onDemandAgents.map((agentId) => ({ agentId, pendingAnnounce: false }))
  state.onDemandMcps = onDemandMcps.map((mcpProviderId) => ({ mcpProviderId, pendingAnnounce: false }))
  state.modes = MODES
  state.prioritizeAccountDefaults = false
  state.defaultRuntime = 'claude'
}

async function newChatLike(agentId?: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useNewChatLike('chat-1', agentId), { wrapper })
  await act(async () => { await result.current() })
}

const newChatKey = composerDraftKey(undefined, NEW_CHAT_DRAFT_SURFACE)
const draft = (key = newChatKey) => useComposerDraftStore.getState().drafts[key]

beforeEach(() => {
  sends.mockClear()
  useChatStore.getState().setActiveChatId('chat-1')
})

describe('New chat like this one', () => {
  it('a direct chat with one of the user agents: that agent, no mode', async () => {
    setChat({ agentId: 'invoices', router: 'direct' })
    await newChatLike()
    expect(draft()).toMatchObject({ pendingAgentIds: ['invoices'], pendingMcpIds: [], modeSelection: 'none', coordinate: false, conductorId: null })
    expect(useChatStore.getState().activeChatId).toBeNull()
    expect(sends).not.toHaveBeenCalled()
  })

  it('a runtime chat: no agent (its hidden runtime is not one), its mode', async () => {
    setChat({ agentId: CONDUCTOR.id, router: 'direct', modeId: 'mode-codex' })
    await newChatLike()
    expect(draft()).toMatchObject({ pendingAgentIds: null, modeSelection: { id: 'mode-codex' }, coordinate: false, conductorId: null })
  })

  it('a human-routed chat: every agent in its order, not coordinated', async () => {
    setChat({ agentId: null, router: 'human' }, ['travel', 'invoices', 'gone'])
    await newChatLike()
    expect(draft()).toMatchObject({ pendingAgentIds: ['travel', 'invoices'], coordinate: false, conductorId: null, modeSelection: 'none' })
  })

  it('a human-routed chat keeps human routing, whatever the Settings default; other routers leave the default', () => {
    expect(chatDraftRouting({ agentId: null, router: 'human', modeId: null }, USER_AGENTS, ['travel', 'invoices'], []).multiAgentRouting).toBe('human')
    expect(chatDraftRouting({ agentId: 'research', router: 'coordinator', modeId: null }, USER_AGENTS, ['travel'], []).multiAgentRouting).toBeNull()
    expect(chatDraftRouting({ agentId: 'research', router: 'direct', modeId: null }, USER_AGENTS, [], []).multiAgentRouting).toBeNull()
  })

  it('a runtime chat with no mode: the runtime mode of the engine its runtime runs', async () => {
    setChat({ agentId: CODEX_RUNTIME.id, router: 'direct', modeId: null })
    state.agents = [...USER_AGENTS, CODEX_RUNTIME]
    await newChatLike()
    expect(draft()).toMatchObject({ pendingAgentIds: null, modeSelection: { id: 'rt-codex' }, coordinate: false })
  })

  it('a runtime chat with no mode and no runtime mode for its engine: none', () => {
    expect(chatDraftRouting({ agentId: CODEX_RUNTIME.id, router: 'direct', modeId: null }, [CODEX_RUNTIME], [], [], { modes: [MODES[0]], defaultEngine: 'claude' }).modeSelection).toBe('none')
    // An agent's chat is never given a runtime mode.
    expect(chatDraftRouting({ agentId: 'invoices', router: 'direct', modeId: null }, USER_AGENTS, [], [], { modes: MODES, defaultEngine: 'claude' }).modeSelection).toBe('none')
  })

  it('a runtime chat with no mode, while the default still runs its engine: none, the default it ran on', async () => {
    setChat({ agentId: CODEX_RUNTIME.id, router: 'direct', modeId: null })
    state.agents = [...USER_AGENTS, CODEX_RUNTIME]
    state.defaultRuntime = 'codex'
    await newChatLike()
    expect(draft()).toMatchObject({ modeSelection: 'none' })
  })

  it('a runtime chat with no mode, whose default mode runs its engine: none', async () => {
    setChat({ agentId: CODEX_RUNTIME.id, router: 'direct', modeId: null })
    state.agents = [...USER_AGENTS, CODEX_RUNTIME]
    state.modes = [...MODES, mode('codex-writer', null, { engine: 'codex', isDefault: true })]
    await newChatLike()
    expect(draft()).toMatchObject({ modeSelection: 'none' })
  })

  it('the engine a chat with no mode runs on: the effective default mode’s, else the Default runtime', () => {
    expect(effectiveDefaultEngine(MODES, false, 'claude')).toBe('claude')
    expect(effectiveDefaultEngine([...MODES, mode('d', null, { engine: 'codex', isDefault: true })], false, 'claude')).toBe('codex')
    // A default mode on the Default runtime runs whatever that is.
    expect(effectiveDefaultEngine([...MODES, mode('d', null, { isDefault: true })], false, 'codex')).toBe('codex')
    // The account's default wins only when the user prioritises it.
    const both = [...MODES, mode('local', null, { engine: 'claude', isDefault: true }), mode('acct', null, { engine: 'codex', managed: true, isDefault: true })]
    expect(effectiveDefaultEngine(both, false, undefined)).toBe('claude')
    expect(effectiveDefaultEngine(both, true, undefined)).toBe('codex')
    expect(effectiveDefaultEngine([], false, undefined)).toBeUndefined()
  })

  it('a coordinated chat: coordinated, its conductor, its on-demand servers', async () => {
    setChat({ agentId: 'research', router: 'coordinator', modeId: 'mode-1' }, ['travel'], ['github', 'linear'])
    await newChatLike()
    expect(draft()).toMatchObject({
      pendingAgentIds: ['research', 'travel'], pendingMcpIds: ['github', 'linear'],
      coordinate: true, conductorId: 'research', modeSelection: { id: 'mode-1' }
    })
  })

  it('a chat coordinated by its hidden runtime: coordinated, default conductor', () => {
    expect(chatDraftRouting({ agentId: CONDUCTOR.id, router: 'coordinator', modeId: null }, [...USER_AGENTS, CONDUCTOR], ['travel', 'invoices'], [])).toEqual({
      pendingAgentIds: ['travel', 'invoices'], pendingMcpIds: [], coordinate: true, conductorId: null, modeSelection: 'none', multiAgentRouting: null
    })
  })

  it('keeps what the new-chat draft already holds besides its routing', async () => {
    useComposerDraftStore.getState().update(newChatKey, () => ({
      text: 'half a thought',
      notes: [{ id: 'n1', title: 'Note' }],
      pathRefs: [{ path: '/tmp/a.txt', kind: 'file' } as never],
      pendingAgentIds: ['travel'],
      coordinate: true
    }))
    setChat({ agentId: 'invoices', router: 'direct' })
    await newChatLike()
    expect(draft()).toMatchObject({
      text: 'half a thought', notes: [{ id: 'n1', title: 'Note' }], pathRefs: [{ path: '/tmp/a.txt' }],
      pendingAgentIds: ['invoices'], coordinate: false
    })
  })

  it('writes the agent page draft when embedded there, and leaves the open chat alone', async () => {
    setChat({ agentId: 'invoices', router: 'direct' })
    await newChatLike('invoices')
    expect(draft(composerDraftKey(undefined, 'agent:invoices'))).toMatchObject({ pendingAgentIds: ['invoices'] })
    expect(draft()).toBeUndefined()
    expect(useChatStore.getState().activeChatId).toBe('chat-1')
  })
})
