import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { RunEvent } from '../../../shared/runEvents'
import type { RunWatchMessage } from '../../../shared/runWatch'

/**
 * Live turn completion requests a semantic after_turn refresh. Main decides
 * whether that reads a folder file or asks Cinna for existing environment
 * status. Neither snapshot replay nor an in-progress delta requests a refresh.
 */

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { useLiveRunWatch } = await import('./useLiveRunWatch')
const { useChatStore } = await import('../stores/chat.store')
const { useAuthStore } = await import('../stores/auth.store')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

type StreamCallback = (event: RunWatchMessage) => void

let ending: RunEvent
let send: ReturnType<typeof vi.fn>
let statusGet: ReturnType<typeof vi.fn>

function signInAs(type: 'local_user' | 'cinna_user'): void {
  useAuthStore.setState({
    currentUser: {
      id: 'u1',
      type,
      username: 'u',
      displayName: 'U',
      hasPassword: false,
      createdAt: new Date()
    }
  } as never)
}

beforeEach(() => {
  statusGet = vi.fn().mockResolvedValue({ success: true, item: null })
  ending = { type: 'done' }
  send = vi.fn()
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    run: { watch: send, cancel: vi.fn() },
    agentStatus: { list: vi.fn().mockResolvedValue({ success: true, items: [] }), get: statusGet },
    agents: { checkReadiness: vi.fn().mockResolvedValue(null) },
    chat: { get: vi.fn().mockResolvedValue(null) }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function runTurn(agentId: string): Promise<void> {
  useChatStore.getState().setActiveChatId('chat-1')
  send.mockImplementation((_chatId: string, cb: StreamCallback) => {
    cb({ type: 'snapshot', runId: 'run-1', sequence: 0, agentId, active: true, replayAvailable: true, baselineMessageIds: [], events: [] })
    cb({ type: 'event', runId: 'run-1', sequence: 1, agentId, event: ending })
    return () => {}
  })
  await act(async () => { renderHook(() => useLiveRunWatch(), { wrapper }) })
}

describe('useChatStream — the post-turn status pull', () => {
  it('re-reads a folder agent’s status without running its refresh command', async () => {
    signInAs('local_user')
    await runTurn('folder:alpha')

    await waitFor(() =>
      // The consequence that matters: `forceRefresh` is false, so no subprocess
      // is spawned and no turn lock is taken behind the user's next message.
      expect(statusGet).toHaveBeenCalledWith({ agentId: 'folder:alpha', intent: 'after_turn' })
    )
  })

  it('re-reads a folder agent’s status on a cinna account too', async () => {
    // The account type is irrelevant to a folder agent: its status lives on
    // this machine either way.
    signInAs('cinna_user')
    await runTurn('folder:alpha')
    await waitFor(() =>
      expect(statusGet).toHaveBeenCalledWith({ agentId: 'folder:alpha', intent: 'after_turn' })
    )
  })

  it('still force-refreshes a remote agent for a cinna account', async () => {
    signInAs('cinna_user')
    await runTurn('a-remote')
    await waitFor(() =>
      expect(statusGet).toHaveBeenCalledWith({ agentId: 'a-remote', intent: 'after_turn' })
    )
  })

  it('lets main resolve optional status even under a local account', async () => {
    signInAs('local_user')
    await runTurn('a-remote')
    expect(statusGet).toHaveBeenCalledWith({ agentId: 'a-remote', intent: 'after_turn' })
  })

  it('pulls on an errored turn too — the agent may have written its status first', async () => {
    signInAs('local_user')
    ending = { type: 'error', error: 'failed' }
    await runTurn('folder:alpha')
    await waitFor(() =>
      expect(statusGet).toHaveBeenCalledWith({ agentId: 'folder:alpha', intent: 'after_turn' })
    )
  })

  it('does not pull mid-stream', async () => {
    signInAs('local_user')
    ending = { type: 'delta', kind: 'text', text: 'hi' }
    await runTurn('folder:alpha')
    expect(statusGet).not.toHaveBeenCalled()
  })
})

it('replaying a finished turn does not request another status refresh', async () => {
  signInAs('local_user')
  useChatStore.getState().setActiveChatId('chat-1')
  send.mockImplementation((_chatId: string, cb: StreamCallback) => {
    cb({ type: 'snapshot', runId: 'old-run', sequence: 2, agentId: 'folder:alpha', active: false,
      replayAvailable: true, baselineMessageIds: [], events: [{ type: 'done' }] })
    return () => {}
  })
  await act(async () => { renderHook(() => useLiveRunWatch(), { wrapper }) })
  expect(statusGet).not.toHaveBeenCalled()
})
