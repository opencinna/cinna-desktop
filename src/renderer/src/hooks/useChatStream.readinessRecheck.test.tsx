import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { RunEvent } from '../../../shared/runEvents'

/**
 * A direct agent turn that ends in `error` re-asks the agent's readiness, so a
 * stale `ok` corrects itself and the next send is refused with the reason
 * instead of failing the same way. A turn that ends in `done` asks nothing, and
 * a re-check that cannot run leaves the turn's own ending untouched.
 */

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined }
}

const { useChatStream } = await import('./useChatStream')
const { useChatStore } = await import('../stores/chat.store')

type StreamCallback = (event: RunEvent) => void

let ending: RunEvent
let checkReadiness: ReturnType<typeof vi.fn>

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

function installApi(agents: Record<string, unknown>): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    app: { setTheme: async () => undefined },
    run: {
      send: vi.fn((_c: string, _t: string, cb: StreamCallback) => {
        cb({ type: 'request-id', requestId: 'req-1' })
        cb(ending)
      }),
      cancel: vi.fn()
    },
    agents,
    agentStatus: {
      list: vi.fn().mockResolvedValue({ success: true, items: [] }),
      get: vi.fn().mockResolvedValue({ success: true, item: null })
    },
    chat: { get: vi.fn() }
  }
}

async function runTurn(): Promise<void> {
  const { result } = renderHook(() => useChatStream(), { wrapper })
  await act(async () => {
    result.current.startRun('chat-1', 'hello', {
      target: { kind: 'agent', agentId: 'agent-1' }
    })
  })
}

beforeEach(() => {
  checkReadiness = vi.fn().mockResolvedValue(null)
  installApi({ checkReadiness })
})

describe('useChatStream — readiness after a failed turn', () => {
  it('re-asks the agent’s readiness when its turn ends in an error', async () => {
    ending = { type: 'error', error: 'Could not reach the agent.' }
    await runTurn()
    await waitFor(() => expect(checkReadiness).toHaveBeenCalledWith('agent-1'))
  })

  it('asks nothing when the turn ends normally', async () => {
    ending = { type: 'done', stopReason: 'end_turn' }
    await runTurn()
    await new Promise((r) => setTimeout(r, 0))
    expect(checkReadiness).not.toHaveBeenCalled()
  })

  it('ends the turn the same way when the re-check is refused', async () => {
    checkReadiness.mockRejectedValue(new Error('No handler registered'))
    ending = { type: 'error', error: 'Could not reach the agent.' }
    await runTurn()
    await waitFor(() => expect(checkReadiness).toHaveBeenCalled())
    expect(useChatStore.getState().isStreaming).toBe(false)
  })
})
