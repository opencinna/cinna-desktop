import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Esc Esc stops a running turn in an active chat — the Stop button's action,
 * reachable without leaving the keyboard. A lone Esc only arms the chord.
 */

const cancelChat = vi.hoisted(() => vi.fn(async () => undefined))

function namespace(methods: Record<string, unknown> = {}): unknown {
  return new Proxy(methods, {
    get: (target, method: string) =>
      method in target ? target[method] : method.startsWith('on') ? () => () => undefined : async () => []
  })
}
;(window as unknown as { api: unknown }).api = new Proxy(
  {},
  { get: (_t, ns: string) => (ns === 'run' ? namespace({ cancelChat }) : namespace()) }
)

const { ChatInput } = await import('./ChatInput')
const { useChatStore } = await import('../../stores/chat.store')

function mount(activeRunId: string | null): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['chat', 'chat-1'], {
    id: 'chat-1', router: 'direct', agentId: null, modeId: null, providerId: null, modelId: null,
    messages: [], activeRunId
  })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  render(createElement(ChatInput, { chatId: 'chat-1' }), { wrapper })
}

const esc = (): void => { fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' }) }

beforeEach(() => {
  vi.clearAllMocks()
  useChatStore.getState().reset()
})
afterEach(() => vi.restoreAllMocks())

describe('double Esc in an active chat', () => {
  it('stops a running turn, like the Stop button', () => {
    mount('run-1')
    expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('title')).toBe('Stop (Esc Esc)')
    esc()
    esc()
    expect(cancelChat).toHaveBeenCalledTimes(1)
    expect(cancelChat).toHaveBeenCalledWith('chat-1')
  })

  it('stops a turn streaming over the port', () => {
    useChatStore.setState({ isStreaming: true })
    mount(null)
    esc()
    esc()
    expect(cancelChat).toHaveBeenCalledWith('chat-1')
  })

  it('does nothing on a single Esc', () => {
    mount('run-1')
    esc()
    expect(cancelChat).not.toHaveBeenCalled()
  })

  it('does nothing when the second Esc lands after the window', () => {
    mount('run-1')
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    esc()
    now.mockReturnValue(10_401)
    esc()
    expect(cancelChat).not.toHaveBeenCalled()
  })

  it('does nothing with no run', () => {
    mount(null)
    esc()
    esc()
    expect(cancelChat).not.toHaveBeenCalled()
  })
})
