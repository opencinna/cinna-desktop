import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdaterState } from '../../../../shared/updaterState'

// The real UpdateStatusButton and store: the badge's placement depends on the
// sidebar being out of view, and its state arrives over the updater bridge.
vi.mock('../../hooks/useStartNewChat', () => ({ useStartNewChat: () => vi.fn() }))
vi.mock('../chat/JobOriginBanner', () => ({ JobOriginBanner: () => null }))
vi.mock('../inbox/InboxButton', () => ({ InboxButton: () => null }))
vi.mock('../agents/AgentStatusButton', () => ({ AgentStatusButton: () => null }))

let snapshot: UpdaterState = { phase: 'idle' }
const listeners: ((state: UpdaterState) => void)[] = []
const promptInstall = vi.fn(async () => ({ success: true }))

;(window as unknown as { api: Record<string, unknown> }).api = {
  app: { setTheme: async () => undefined },
  updater: {
    getState: async () => snapshot,
    onState: (cb: (state: UpdaterState) => void) => {
      listeners.push(cb)
      return () => undefined
    },
    promptInstall
  }
}

const { TopBar } = await import('./TopBar')
const { useUIStore } = await import('../../stores/ui.store')
const { useUpdaterStore } = await import('../../stores/updater.store')

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client }, children)
}

const READY = /Update 0\.5\.3 ready/

async function renderTopBar(): Promise<void> {
  render(createElement(TopBar), { wrapper })
  // Let the store's getState snapshot settle.
  await act(async () => {})
}

beforeEach(() => {
  snapshot = { phase: 'idle' }
  listeners.length = 0
  promptInstall.mockClear()
  useUpdaterStore.setState({ state: { phase: 'idle' }, subscribed: false, unsubscribe: null })
  useUIStore.setState({ sidebarOpen: false, sidebarDocking: 'fixed', sidebarPeek: false })
})

describe('TopBar — update badge', () => {
  it('shows the ready badge while the sidebar is collapsed, and installs on click', async () => {
    snapshot = { phase: 'downloaded', version: '0.5.3' }
    await renderTopBar()
    fireEvent.click(screen.getByRole('button', { name: READY }))
    expect(promptInstall).toHaveBeenCalledTimes(1)
  })

  it('appears when a download finishes after mount', async () => {
    await renderTopBar()
    expect(screen.queryByRole('button', { name: READY })).toBeNull()
    act(() => listeners.forEach((cb) => cb({ phase: 'downloaded', version: '0.5.3' })))
    expect(screen.getByRole('button', { name: READY })).toBeTruthy()
  })

  it('stays out of the top bar while downloading and while the sidebar shows its own badge', async () => {
    snapshot = { phase: 'downloading', version: '0.5.3', percent: 40 }
    await renderTopBar()
    expect(screen.queryByTitle(/Downloading update/)).toBeNull()

    act(() => listeners.forEach((cb) => cb({ phase: 'downloaded', version: '0.5.3' })))
    expect(screen.getByRole('button', { name: READY })).toBeTruthy()
    act(() => useUIStore.setState({ sidebarOpen: true }))
    expect(screen.queryByRole('button', { name: READY })).toBeNull()
  })

  it('subscribes once when the sidebar and top bar buttons mount together', async () => {
    const { subscribe } = useUpdaterStore.getState()
    await Promise.all([subscribe(), subscribe()])
    expect(listeners).toHaveLength(1)
  })

  it('keeps a broadcast that lands before the snapshot', async () => {
    let release: (s: UpdaterState) => void = () => undefined
    const api = (window as unknown as { api: { updater: { getState: () => Promise<UpdaterState> } } }).api
    const original = api.updater.getState
    api.updater.getState = () => new Promise((resolve) => { release = resolve })
    try {
      const pending = useUpdaterStore.getState().subscribe()
      listeners.forEach((cb) => cb({ phase: 'downloaded', version: '0.5.3' }))
      release({ phase: 'downloading', version: '0.5.3', percent: 90 })
      await pending
      expect(useUpdaterStore.getState().state).toEqual({ phase: 'downloaded', version: '0.5.3' })
    } finally {
      api.updater.getState = original
    }
  })
})
