import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionTelemetry, SessionTelemetryChangedPayload } from '../../../../shared/sessionTelemetry'

/**
 * The prompt-cache notice in the composer's notice slot: shown on an open chat
 * with a cold cache, one strip at a time with readiness winning, and gone the
 * moment a message is sent.
 */

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)

const agentList = vi.hoisted(() => ({ current: [] as unknown[] }))
const chatDetail = vi.hoisted(() => ({ current: null as unknown }))
const reading = vi.hoisted(() => ({ current: null as unknown }))
const runStart = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ ok: true })))
const telemetryListeners = vi.hoisted(() => [] as Array<(payload: SessionTelemetryChangedPayload) => void>)

/** A namespace with named methods, every other method a harmless default. */
function namespace(methods: Record<string, unknown>): unknown {
  return new Proxy(methods, {
    get: (target, method: string) =>
      method in target ? target[method] : method.startsWith('on') ? () => () => undefined : async () => []
  })
}

;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (ns === 'agents') {
        return namespace({ list: async () => agentList.current, checkReadiness: async () => null, listCliCommands: async () => [] })
      }
      if (ns === 'chat') return namespace({ get: async () => chatDetail.current })
      if (ns === 'run') return namespace({ start: runStart })
      if (ns === 'localAgents') return namespace({ list: async () => ({ agents: [], errors: [] }) })
      if (ns === 'engine') return namespace({ defaultRuntime: async () => ({ engine: 'opencode' }) })
      if (ns === 'sessionTelemetry') {
        return namespace({
          get: async () => ({ ok: true, telemetry: reading.current }),
          onChanged: (handler: (payload: SessionTelemetryChangedPayload) => void) => {
            telemetryListeners.push(handler)
            return () => telemetryListeners.splice(telemetryListeners.indexOf(handler), 1)
          }
        })
      }
      return namespace({})
    }
  }
)

Element.prototype.scrollIntoView = function scrollIntoView(): void {}

const { ChatInput } = await import('./ChatInput')
const { useCacheNoticeStore } = await import('../../stores/cacheNotice.store')
const { useComposerDraftStore, composerDraftKey } = await import('../../stores/composerDraft.store')

const chatDraftKey = composerDraftKey(undefined, 'chat:chat-1')

function agent(readiness: unknown): Record<string, unknown> {
  return {
    id: 'agent-1', name: 'Invoices', description: null, protocol: 'a2a', cardUrl: 'http://127.0.0.1:9/card',
    endpointUrl: null, protocolInterfaceUrl: null, protocolInterfaceVersion: null, hasAccessToken: false,
    cardData: null, skills: null, enabled: true, source: 'local', remoteTargetType: null, remoteTargetId: null,
    remoteMetadata: null, localPath: null, localRootId: null, driver: 'a2a',
    capabilities: { attachments: 'none', commands: 'card', auth: 'none' },
    readiness, createdAt: new Date('2026-01-01T00:00:00Z')
  }
}

function telemetry(lastRequestAt: number): SessionTelemetry {
  return {
    chatId: 'chat-1', engine: 'codex', auth: { kind: 'api_key' },
    model: { resolved: 'gpt-5.5', source: 'init' },
    context: { used: 120_000, size: 400_000, sizeAuthoritative: true },
    totals: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costSource: 'runtime', turns: 1, tokenScope: 'turn', byModel: {}, bySession: {} },
    cache: { lastRequestAt, ttlSource: 'assumed' },
    updatedAt: lastRequestAt
  }
}

const onNewChatLike = vi.fn()

function mount(readiness: unknown): QueryClient {
  const target = agent(readiness)
  agentList.current = [target]
  chatDetail.current = { id: 'chat-1', agentId: 'agent-1', router: 'direct', modeId: null, providerId: null, modelId: null, messages: [] }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], agentList.current)
  client.setQueryData(['chat', 'chat-1'], chatDetail.current)
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => createElement(QueryClientProvider, { client }, children)
  render(createElement(ChatInput, { chatId: 'chat-1', onNewChatLike }), { wrapper })
  return client
}

/** Lets the queries and effects that a change set off run. */
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const cachePanel = (): HTMLElement | null => screen.queryByRole('region', { name: 'Prompt cache notice' })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  reading.current = telemetry(T0 - 30 * HOUR)
  useCacheNoticeStore.setState({ dismissed: {} })
  useComposerDraftStore.setState({ drafts: {} })
  runStart.mockClear()
  onNewChatLike.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the composer prompt-cache notice', () => {
  it('shows on an open chat with a cold cache, and New chat asks for the new-chat screen', async () => {
    mount(null)
    await waitFor(() => expect(cachePanel()).not.toBeNull())
    expect(cachePanel()!.textContent).toContain('Prompt cache expired (idle 30 h).')
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onNewChatLike).toHaveBeenCalledTimes(1)
  })

  it('gives way to a readiness notice: one strip at a time', async () => {
    mount({ state: 'unreachable', reason: 'Could not reach the agent.' })
    expect(screen.getByText('Could not reach the agent.')).toBeTruthy()
    // The telemetry has arrived, and still only the readiness strip shows.
    await waitFor(() => expect(screen.getByRole('status', { name: 'Agent status' })).toBeTruthy())
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(cachePanel()).toBeNull()
  })

  it('does not take the slot when readiness clears in place, only at the next snapshot', async () => {
    const client = mount({ state: 'unreachable', reason: 'Could not reach the agent.' })
    await waitFor(() => expect(screen.getByRole('status', { name: 'Agent status' })).toBeTruthy())
    await settle()
    // "Check again" succeeded: the readiness strip goes, and the slot stays empty.
    act(() => { client.setQueryData(['agents'], [agent(null)]) })
    await settle()
    expect(screen.queryByText('Could not reach the agent.')).toBeNull()
    expect(cachePanel()).toBeNull()
    // The user comes back to the window: a snapshot, and the strip shows.
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(cachePanel()).not.toBeNull())
  })

  it.each([
    ['a file', { files: { attachments: [{ id: 'f1', filename: 'a.txt', size: 3, mimeType: 'text/plain', source: 'local' as const }], uploading: false, error: null, token: null } }],
    ['an upload', { files: { attachments: [], uploading: true, error: null, token: null } }],
    ['a note', { notes: [{ id: 'n1', title: 'Note' }] }],
    ['a path reference', { pathRefs: [{ path: '/tmp/a.txt', kind: 'file' } as never] }]
  ])('takes no new snapshot on focus while the composer holds %s', async (_what, patch) => {
    reading.current = telemetry(T0 - 60_000)
    mount(null)
    await settle()
    expect(cachePanel()).toBeNull()
    vi.setSystemTime(T0 + 3 * HOUR)
    act(() => { useComposerDraftStore.getState().update(chatDraftKey, () => patch) })
    act(() => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(cachePanel()).toBeNull()
    act(() => { useComposerDraftStore.setState({ drafts: {} }) })
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(cachePanel()).not.toBeNull())
  })

  it('goes away when a message is sent', async () => {
    mount(null)
    await waitFor(() => expect(cachePanel()).not.toBeNull())
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(cachePanel()).toBeNull()
    await waitFor(() => expect(runStart).toHaveBeenCalled())
    expect(cachePanel()).toBeNull()
  })
})
