import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AppShortcut } from '../../../shared/appShortcuts'
import { useAppShortcuts } from './useAppShortcuts'
import { useUIStore } from '../stores/ui.store'
import { useChatStore } from '../stores/chat.store'
import { useToastStore } from '../stores/toast.store'

/**
 * What the menu's `app:shortcut` event does on each screen: ⌘N is the `+`,
 * ⇧⌘N carries over a direct chat's agent, ⌘<digit> starts its bound agent or
 * says why it cannot.
 */

const agents = [
  { id: 'alpha', name: 'Alpha', enabled: true },
  { id: 'off', name: 'Off Agent', enabled: false }
]
let emit: (shortcut: AppShortcut) => void
const unsubscribe = vi.fn()
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  unsubscribe.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    app: {
      onShortcut: (handler: (s: AppShortcut) => void) => {
        emit = handler
        return unsubscribe
      }
    },
    agents: {
      list: vi.fn().mockResolvedValue(agents),
      listShortcuts: vi.fn().mockResolvedValue([
        { slot: 1, agentId: 'alpha' },
        { slot: 2, agentId: 'off' },
        { slot: 3, agentId: 'gone' }
      ])
    },
    chat: { get: vi.fn().mockResolvedValue({ id: 'c1', router: 'direct', agentId: 'alpha' }) }
  }
  useUIStore.setState({ activeView: 'settings', pendingAgentId: null, activeJobId: 'job' })
  useChatStore.setState({ activeChatId: 'c1' })
  useToastStore.setState({ toast: null })
})
afterEach(() => { client.clear(); vi.restoreAllMocks() })
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

it('⌘N opens the new-chat screen and leaves the job behind', async () => {
  renderHook(() => useAppShortcuts(), { wrapper })
  act(() => emit({ kind: 'new-chat' }))
  expect(useUIStore.getState().activeView).toBe('chat')
  expect(useUIStore.getState().activeJobId).toBeNull()
  expect(useChatStore.getState().activeChatId).toBeNull()
  expect(useUIStore.getState().pendingAgentId).toBeNull()
})

it('⇧⌘N in a direct chat starts a new chat with that chat’s agent', async () => {
  useUIStore.setState({ activeView: 'chat' })
  renderHook(() => useAppShortcuts(), { wrapper })
  act(() => emit({ kind: 'new-chat-same-agent' }))
  await waitFor(() => expect(useUIStore.getState().pendingAgentId).toBe('alpha'))
  expect(useUIStore.getState().activeView).toBe('chat')
})

it('⇧⌘N with no agent on screen behaves like ⌘N', async () => {
  renderHook(() => useAppShortcuts(), { wrapper })
  act(() => emit({ kind: 'new-chat-same-agent' }))
  await waitFor(() => expect(useUIStore.getState().activeView).toBe('chat'))
  expect(useChatStore.getState().activeChatId).toBeNull()
  expect(useUIStore.getState().pendingAgentId).toBeNull()
})

it('⌘<digit> starts the bound agent', async () => {
  renderHook(() => useAppShortcuts(), { wrapper })
  act(() => emit({ kind: 'agent', slot: 1 }))
  await waitFor(() => expect(useUIStore.getState().pendingAgentId).toBe('alpha'))
  expect(useUIStore.getState().activeView).toBe('chat')
})

it('⌘<digit> for a disabled or missing agent only says so', async () => {
  renderHook(() => useAppShortcuts(), { wrapper })
  act(() => emit({ kind: 'agent', slot: 2 }))
  await waitFor(() => expect(useToastStore.getState().toast?.message).toBe('Off Agent is disabled'))
  act(() => emit({ kind: 'agent', slot: 3 }))
  await waitFor(() => expect(useToastStore.getState().toast?.message).toMatch(/for .*3 is no longer available/))
  expect(useUIStore.getState().activeView).toBe('settings')
  expect(useUIStore.getState().pendingAgentId).toBeNull()
})

it('an unbound digit does nothing, and unmounting unsubscribes', async () => {
  const view = renderHook(() => useAppShortcuts(), { wrapper })
  await act(async () => emit({ kind: 'agent', slot: 9 }))
  expect(useUIStore.getState().activeView).toBe('settings')
  expect(useToastStore.getState().toast).toBeNull()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalled()
})

it('does nothing while a modal is open, so its form is not thrown away', async () => {
  const modal = document.createElement('div')
  modal.setAttribute('aria-modal', 'true')
  document.body.appendChild(modal)
  try {
    renderHook(() => useAppShortcuts(), { wrapper })
    await act(async () => emit({ kind: 'new-chat' }))
    await act(async () => emit({ kind: 'agent', slot: 1 }))
    expect(useUIStore.getState().activeView).toBe('settings')
    expect(useUIStore.getState().pendingAgentId).toBeNull()
  } finally {
    modal.remove()
  }
})

it('⌘<digit> re-reads bindings invalidated while no Interface tab was open', async () => {
  renderHook(() => useAppShortcuts(), { wrapper })
  act(() => emit({ kind: 'agent', slot: 1 }))
  await waitFor(() => expect(useUIStore.getState().pendingAgentId).toBe('alpha'))
  useUIStore.setState({ activeView: 'settings', pendingAgentId: null })
  vi.mocked(window.api.agents.listShortcuts).mockResolvedValue([{ slot: 1, agentId: 'off' }])
  await client.invalidateQueries({ queryKey: ['agents', 'shortcuts'] })
  act(() => emit({ kind: 'agent', slot: 1 }))
  await waitFor(() => expect(useToastStore.getState().toast?.message).toBe('Off Agent is disabled'))
})
