import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatRouter } from '../../../../shared/chatRouting'

/**
 * A vault agent in the composer: Enter while its vault is locked unlocks it
 * and sends once it is open (once; not after a cancelled unlock, a cleared
 * composer, or from the row's Unlock button alone), and typing to it while it
 * is unlocked touches the vault, throttled. Harness from ChatInput.readiness.test.tsx.
 *
 * Refused: the agent a message goes straight to — the one the chat's router
 * answers with, or a new chat's first-picked agent when the router it would
 * create is not `coordinator` — when its readiness is an answer that is not
 * `ok`. Not refused: an answer of `null` (never checked, or a check that could
 * not tell), an agent the local model conducts as a tool, and a bare catalog
 * `/run:` (a script on this machine, not a turn). The line never depends on
 * what is typed.
 */

const agentList = vi.hoisted(() => ({ current: [] as unknown[] }))
/** What `localAgents.list` answers: the folder agents behind the composer's notice rows. */
const localAgentList = vi.hoisted(() => ({ current: [] as unknown[] }))
/** What `chat.get` answers: a refetch on mount must not replace the seeded chat. */
const chatDetail = vi.hoisted(() => ({ current: null as unknown }))
const spies = vi.hoisted(() => ({
  list: vi.fn(async () => agentList.current),
  agentSend: vi.fn(),
  llmSend: vi.fn(),
  checkReadiness: vi.fn(async () => null as unknown),
  cinnaReauth: vi.fn(async () => ({ success: true }) as unknown),
  notesList: vi.fn(async () => [] as unknown[]),
  engineLogin: vi.fn(async (_engine: string) => ({ outcome: 'logged_in', command: null }) as unknown),
  engineLoginCancel: vi.fn(async (_engine: string) => true),
  engineLoginRunning: vi.fn(async (): Promise<Record<'claude' | 'codex', 'preparing' | 'waiting' | null>> => ({ claude: null, codex: null })),
  clipboardWrite: vi.fn(async (_text: string) => ({ success: true })),
  notesGet: vi.fn(async () => null as unknown),
  settingsGetAll: vi.fn(async () => ({ notesCapability: 'on', dashboardsCapability: 'on' }))
}))

const vault = vi.hoisted(() => ({
  unlock: vi.fn(async (_agentId: string): Promise<unknown> => ({ ok: true, data: { state: 'unlocked' } })),
  touch: vi.fn(),
  status: vi.fn(async (_agentId: string): Promise<unknown> => ({ ok: true, data: { state: 'unlocked', until: null, lockAfterMs: 300_000 } })),
  availability: vi.fn(async () => ({ availability: { ok: true }, backend: 'fake', flavor: 'fake', capabilities: { separateKernel: false, hardwareKey: false, perActionPresence: false, lockTimeouts: [30_000, 300_000, 0], idleTouch: true } }) as unknown)
}))

/** Every `useFinishSetup` the composer made, with its options. */
const finishSetupCalls = vi.hoisted(() => ({ current: [] as { agentId: string | null; options: unknown }[] }))
/** `chatModes.list`, replaceable so a test can hold the chat modes pending. */
const chatModes = vi.hoisted(() => ({ list: async (): Promise<unknown[]> => [] }))
/** `providers.list`: the AI credentials on this machine. */
const providerList = vi.hoisted(() => ({ current: [] as unknown[] }))
const openPath = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ success: true })))
/** What `agentSessions.active` answers: the sessions already running. */
const runningSessions = vi.hoisted(() => ({ current: [] as unknown[] }))
const sessionsRead = vi.hoisted(() => vi.fn())

// The dialog itself is FinishSetupDialog's own test; here only who owns it and when it opens.
vi.mock('../agents/local/FinishSetupDialog', async () => {
  const { createElement: h, useState } = await import('react')
  return {
    useFinishSetup: (agentId: string | null, name: string, options?: unknown) => {
      finishSetupCalls.current.push({ agentId, options })
      const [open, setOpen] = useState(false)
      return {
        open: () => setOpen(true),
        dialog: open ? h('div', { role: 'dialog', 'aria-label': `Finish setting up ${name}` }) : null
      }
    }
  }
})

/** A namespace with named methods, every other method a harmless default. */
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

const api: Record<string, unknown> = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'agents') {
        return namespace({
          list: spies.list,
          onRemoteSyncComplete: () => () => undefined,
          onReadinessChanged: () => () => undefined,
          checkReadiness: spies.checkReadiness,
          listCliCommands: async () => [],
          sendMessage: spies.agentSend,
          cancelMessage: async () => ({ success: true })
        })
      }
      if (ns === 'chat') return namespace({ get: async () => chatDetail.current })
      if (ns === 'vault') return namespace({ unlock: vault.unlock, touch: vault.touch, status: vault.status, availability: vault.availability })
      if (ns === 'agentSessions') {
        return namespace({ active: async () => { sessionsRead(); return { ok: true, sessions: runningSessions.current } } })
      }
      if (ns === 'llm') return namespace({ sendMessage: spies.llmSend })
      if (ns === 'auth') return namespace({ cinnaReauth: spies.cinnaReauth })
      if (ns === 'notes') return namespace({ list: spies.notesList, get: spies.notesGet })
      // Notes is an optional capability; the `?` picker needs it on.
      if (ns === 'settings') return namespace({ getAll: spies.settingsGetAll })
      if (ns === 'clipboard') return namespace({ writeText: spies.clipboardWrite })
      if (ns === 'localAgents') return namespace({ list: async () => ({ agents: localAgentList.current, errors: [] }), openPath })
      if (ns === 'engine') return namespace({ defaultRuntime: async () => ({ engine: 'opencode' }) })
      if (ns === 'chatModes') return namespace({ list: () => chatModes.list() })
      if (ns === 'providers') return namespace({ list: async () => providerList.current })
      if (ns === 'localTools') {
        return namespace({
          engineLogin: spies.engineLogin,
          engineLoginCancel: spies.engineLoginCancel,
          engineLoginRunning: spies.engineLoginRunning
        })
      }
      return namespace({})
    }
  }
)
;(window as unknown as { api: unknown }).api = api

// jsdom implements no layout, so the popup's keyboard-scroll call is absent.
Element.prototype.scrollIntoView = function scrollIntoView(): void {}

const { ChatInput } = await import('./ChatInput')


function agent(readiness: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'agent-1',
    name: 'Invoices',
    description: null,
    protocol: 'a2a',
    cardUrl: 'http://127.0.0.1:9/card',
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    hasAccessToken: false,
    cardData: null,
    skills: null,
    enabled: true,
    source: 'local',
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata: null,
    localPath: null,
    localRootId: null,
    driver: 'a2a',
    capabilities: { attachments: 'none', commands: 'card', auth: 'none' },
    readiness,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  }
}


function clientWith(chat: Record<string, unknown> | null): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], agentList.current)
  if (chat) client.setQueryData(['chat', 'chat-1'], chat)
  return client
}



function typeAndEnter(text: string): void {
  const box = screen.getByRole('combobox')
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const LOCKED = { state: 'vault_locked', reason: 'Ledger is in a locked vault.' }

function vaultAgent(readiness: unknown): Record<string, unknown> {
  return agent(readiness, { id: 'folder:v', name: 'Ledger', source: 'vault', driver: 'acp', capabilities: { attachments: 'local', commands: 'catalog', auth: 'none', cwd: true } })
}

/** The new-chat screen with a vault agent picked; `setReadiness` is the readiness push. */
function mountVault(readiness: unknown, onNewChat: (message: string) => void): (next: unknown) => void {
  const client = clientWith(null)
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const props = (target: Record<string, unknown>) => ({
    chatId: null,
    selectedAgent: target as never,
    pendingAgentIds: [target.id as string],
    routerInfo: { router: 'direct' as ChatRouter, agentName: 'Ledger', answererName: 'Ledger' },
    onNewChat
  })
  agentList.current = [vaultAgent(readiness)]
  const { rerender } = render(createElement(ChatInput, props(vaultAgent(readiness))), { wrapper })
  return (next) => rerender(createElement(ChatInput, props(vaultAgent(next))))
}

beforeEach(() => {
  vault.unlock.mockReset()
  vault.unlock.mockResolvedValue({ ok: true, data: { state: 'unlocked' } })
  vault.touch.mockReset()
  vault.status.mockReset()
  vault.status.mockResolvedValue({ ok: true, data: { state: 'unlocked', until: null, lockAfterMs: 300_000 } })
})

describe('Enter on a locked vault agent', () => {
  it('unlocks, then sends what is in the composer once the vault is open — once', async () => {
    const onNewChat = vi.fn()
    const setReadiness = mountVault(LOCKED, onNewChat)
    typeAndEnter('what is owed?')
    await waitFor(() => expect(vault.unlock).toHaveBeenCalledWith('folder:v'))
    expect(onNewChat).not.toHaveBeenCalled()
    await act(async () => { await tick() })
    // The readiness push after the unlock clears the row.
    await act(async () => { setReadiness(null) })
    await waitFor(() => expect(onNewChat).toHaveBeenCalledTimes(1))
    expect(onNewChat).toHaveBeenCalledWith('what is owed?', undefined, undefined)
    await act(async () => { setReadiness({ state: 'ok', reason: null }) })
    await act(async () => { await tick() })
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('sends nothing after an unlock cancelled at the prompt, even when the vault opens later', async () => {
    vault.unlock.mockResolvedValueOnce({ ok: false, code: 'denied', message: 'the user did not approve' })
    const onNewChat = vi.fn()
    const setReadiness = mountVault(LOCKED, onNewChat)
    typeAndEnter('what is owed?')
    await waitFor(() => expect(vault.unlock).toHaveBeenCalled())
    await act(async () => { await tick(); await tick() })
    await act(async () => { setReadiness(null) })
    await act(async () => { await tick() })
    expect(onNewChat).not.toHaveBeenCalled()
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('what is owed?')
  })

  it('sends nothing after an unlock a lock overtook (answered, but still locked), even when the vault opens later', async () => {
    vault.unlock.mockResolvedValueOnce({ ok: true, data: { state: 'locked' } })
    const onNewChat = vi.fn()
    const setReadiness = mountVault(LOCKED, onNewChat)
    typeAndEnter('what is owed?')
    await waitFor(() => expect(vault.unlock).toHaveBeenCalled())
    await act(async () => { await tick(); await tick() })
    await act(async () => { setReadiness(null) })
    await act(async () => { await tick() })
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it('drops the send when the composer is cleared before the vault opens', async () => {
    const onNewChat = vi.fn()
    const setReadiness = mountVault(LOCKED, onNewChat)
    typeAndEnter('what is owed?')
    await waitFor(() => expect(vault.unlock).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    await act(async () => { await tick() })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'something else' } })
    await act(async () => { setReadiness(null) })
    await act(async () => { await tick() })
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it('does not send when only the row’s Unlock was clicked', async () => {
    const onNewChat = vi.fn()
    const setReadiness = mountVault(LOCKED, onNewChat)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() => expect(vault.unlock).toHaveBeenCalled())
    await act(async () => { await tick() })
    await act(async () => { setReadiness(null) })
    await act(async () => { await tick() })
    expect(onNewChat).not.toHaveBeenCalled()
  })
})

describe('typing to a vault agent', () => {
  it('touches its unlocked vault, at most once per 5 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000_000)
      mountVault({ state: 'ok', reason: null }, vi.fn())
      const box = screen.getByRole('combobox')
      // The status and the backend's capabilities arrive first.
      await waitFor(() => { fireEvent.keyDown(box, { key: 'a' }); expect(vault.touch).toHaveBeenCalledTimes(1) })
      fireEvent.keyDown(box, { key: 'b' })
      fireEvent.keyDown(box, { key: 'c' })
      expect(vault.touch).toHaveBeenCalledTimes(1)
      vi.setSystemTime(1_000_000 + 5_000)
      fireEvent.keyDown(box, { key: 'd' })
      expect(vault.touch).toHaveBeenCalledTimes(2)
      expect(vault.touch).toHaveBeenLastCalledWith('folder:v')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never touches a locked vault', async () => {
    vault.status.mockResolvedValue({ ok: true, data: { state: 'locked', until: null, lockAfterMs: 300_000 } })
    mountVault(LOCKED, vi.fn())
    await waitFor(() => expect(vault.status).toHaveBeenCalled())
    await act(async () => { await tick() })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'a' })
    expect(vault.touch).not.toHaveBeenCalled()
  })
})
