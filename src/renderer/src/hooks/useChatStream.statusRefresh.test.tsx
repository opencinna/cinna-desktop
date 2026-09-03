import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * What `useChatStream` does to the status surfaces when an agent turn ends.
 *
 * This was `isCinnaUser && forceRefreshAgentStatus.mutate(agentId)` — dead for a
 * folder agent under a local account. Widening it is not simply flipping the
 * condition, because for a folder agent `forceRefresh: true` **runs the
 * manifest's `status_refresh_command` as a subprocess under the agent's turn
 * lock**. After every single chat message that would run the agent's own health
 * check nobody asked for, and hold the lock the user's *next* message needs —
 * a background refresh refusing a message the user just sent. The re-read is
 * what belongs here; running the command belongs to the Refresh buttons.
 */

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { useChatStream } = await import('./useChatStream')
const { useAuthStore } = await import('../stores/auth.store')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

type StreamCallback = (event: { type: string }) => void

let sendMessage: ReturnType<typeof vi.fn>
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
  // Drives the turn straight to `done` so the post-turn branch runs.
  sendMessage = vi.fn(
    (_agentId: string, _chatId: string, _content: string, cb: StreamCallback) => {
      cb({ type: 'request-id' })
      cb({ type: 'done' })
    }
  )
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    agents: { sendMessage },
    agentStatus: { list: vi.fn().mockResolvedValue({ success: true, items: [] }), get: statusGet },
    chat: { get: vi.fn() }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function runTurn(agentId: string): Promise<void> {
  const { result } = renderHook(() => useChatStream(), { wrapper })
  await act(async () => {
    result.current.startAgent(agentId, 'chat-1', 'hello')
  })
}

describe('useChatStream — the post-turn status pull', () => {
  it('re-reads a folder agent’s status without running its refresh command', async () => {
    signInAs('local_user')
    await runTurn('folder:alpha')

    await waitFor(() =>
      // The consequence that matters: `forceRefresh` is false, so no subprocess
      // is spawned and no turn lock is taken behind the user's next message.
      expect(statusGet).toHaveBeenCalledWith({ agentId: 'folder:alpha', forceRefresh: false })
    )
  })

  it('re-reads a folder agent’s status on a cinna account too', async () => {
    // The account type is irrelevant to a folder agent: its status lives on
    // this machine either way.
    signInAs('cinna_user')
    await runTurn('folder:alpha')
    await waitFor(() =>
      expect(statusGet).toHaveBeenCalledWith({ agentId: 'folder:alpha', forceRefresh: false })
    )
  })

  it('still force-refreshes a remote agent for a cinna account', async () => {
    signInAs('cinna_user')
    await runTurn('a-remote')
    await waitFor(() =>
      expect(statusGet).toHaveBeenCalledWith({ agentId: 'a-remote', forceRefresh: true })
    )
  })

  it('asks for nothing at all for a remote agent under a local account', async () => {
    signInAs('local_user')
    await runTurn('a-remote')
    expect(statusGet).not.toHaveBeenCalled()
  })

  it('pulls on an errored turn too — the agent may have written its status first', async () => {
    signInAs('local_user')
    sendMessage.mockImplementation(
      (_a: string, _c: string, _t: string, cb: StreamCallback) => {
        cb({ type: 'request-id' })
        cb({ type: 'error' })
      }
    )
    await runTurn('folder:alpha')
    await waitFor(() =>
      expect(statusGet).toHaveBeenCalledWith({ agentId: 'folder:alpha', forceRefresh: false })
    )
  })

  it('does not pull mid-stream', async () => {
    signInAs('local_user')
    sendMessage.mockImplementation(
      (_a: string, _c: string, _t: string, cb: StreamCallback) => {
        cb({ type: 'request-id' })
        cb({ type: 'delta' })
      }
    )
    await runTurn('folder:alpha')
    expect(statusGet).not.toHaveBeenCalled()
  })
})
