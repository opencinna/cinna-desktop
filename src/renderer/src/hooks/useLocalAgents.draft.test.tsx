import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../stores/ui.store'
import { useDraftLocalAgent } from './useLocalAgents'

/**
 * Whether a folder agent is being drafted lives in the UI store by agent id,
 * not in the page's mutation instance: the draft runs in main for up to two 90s calls
 * and outlives the page, and the agent's new-chat composer holds sends while
 * the id is listed. So the id goes on when the call starts and comes off on
 * every outcome — from the hook's own callbacks, which run even after the
 * caller unmounted (a per-`mutate` callback would not).
 */

const AGENT_ID = 'folder:alpha'

let release: { resolve: (value: unknown) => void; reject: (err: Error) => void } | null = null
const draft = vi.fn(
  () =>
    new Promise((resolve, reject) => {
      release = { resolve, reject }
    })
)

beforeEach(() => {
  release = null
  draft.mockClear()
  useUIStore.setState({ draftingAgentIds: [] })
  ;(window as unknown as { api: unknown }).api = { localAgents: { draft } }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

function mount(): { result: { current: ReturnType<typeof useDraftLocalAgent> }; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useDraftLocalAgent(), { wrapper })
}

const drafting = (): string[] => useUIStore.getState().draftingAgentIds

describe('useDraftLocalAgent — drafting ids in the UI store', () => {
  it('lists the agent while the draft runs and drops it when the draft succeeds', async () => {
    const { result } = mount()
    act(() => result.current.mutate(AGENT_ID))
    await waitFor(() => expect(drafting()).toEqual([AGENT_ID]))
    expect(draft).toHaveBeenCalledWith(AGENT_ID)

    await act(async () => {
      release?.resolve({ status: 'drafted', reason: null, agent: { id: AGENT_ID } })
    })
    await waitFor(() => expect(drafting()).toEqual([]))
  })

  it('drops the agent when the draft fails', async () => {
    const { result } = mount()
    act(() => result.current.mutate(AGENT_ID))
    await waitFor(() => expect(drafting()).toEqual([AGENT_ID]))

    await act(async () => {
      release?.reject(new Error('the draft could not be written'))
    })
    await waitFor(() => expect(drafting()).toEqual([]))
  })

  it('drops the agent even when the page that started the draft is gone', async () => {
    const { result, unmount } = mount()
    act(() => result.current.mutate(AGENT_ID))
    await waitFor(() => expect(drafting()).toEqual([AGENT_ID]))
    unmount()
    expect(drafting()).toEqual([AGENT_ID])

    await act(async () => {
      release?.resolve({ status: 'skipped', reason: 'No AI credential is configured.', agent: { id: AGENT_ID } })
    })
    await waitFor(() => expect(drafting()).toEqual([]))
  })
})
