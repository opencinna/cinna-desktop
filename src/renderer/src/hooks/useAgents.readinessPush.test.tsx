import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

/**
 * One readiness push, one `agent:list`.
 *
 * Every mounted `useAgents()` subscribes to the push — the composer, the
 * sidebar and the settings tabs each hold one — and a plain invalidate cancels
 * the fetch the previous listener started and starts another, so a single push
 * read the list once per mounted hook.
 */

const handlers: Array<() => void> = []
let finishList: (() => void) | null = null
const list = vi.fn(
  () =>
    new Promise<unknown[]>((resolve) => {
      finishList = () => resolve([])
    })
)

;(window as unknown as { api: unknown }).api = {
  agents: {
    list,
    onRemoteSyncComplete: () => () => undefined,
    onReadinessChanged: (handler: () => void) => {
      handlers.push(handler)
      return () => handlers.splice(handlers.indexOf(handler), 1)
    }
  },
  chat: {}
}

const { useAgents } = await import('./useAgents')

describe('useAgents — the readiness push', () => {
  it('re-reads the list once when several mounted hooks hear the same push', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
      createElement(QueryClientProvider, { client }, children)

    renderHook(() => [useAgents(), useAgents(), useAgents()], { wrapper })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    await act(async () => finishList?.())
    await waitFor(() => expect(client.isFetching({ queryKey: ['agents'] })).toBe(0))
    expect(handlers).toHaveLength(3)

    await act(async () => {
      for (const handler of [...handlers]) handler()
    })
    await act(async () => finishList?.())
    await waitFor(() => expect(client.isFetching({ queryKey: ['agents'] })).toBe(0))
    expect(list).toHaveBeenCalledTimes(2)
  })
})
