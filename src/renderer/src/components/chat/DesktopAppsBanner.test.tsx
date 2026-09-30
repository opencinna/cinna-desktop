import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAppConnectResult } from '../../../../shared/desktopApps'

/**
 * The new-chat offer for a detected Claude Desktop / ChatGPT: what it offers,
 * what a pressed button says while main connects, and what it leaves behind.
 */

const claude = { id: 'claude-desktop', label: 'Claude Desktop', engine: 'claude' }
const chatgpt = { id: 'chatgpt', label: 'ChatGPT', engine: 'codex' }

const api = vi.hoisted(() => ({
  desktopApps: vi.fn(),
  desktopAppConnect: vi.fn(),
  desktopAppRunning: vi.fn(),
  engineLoginCancel: vi.fn(async () => true),
  defaultRuntime: vi.fn(),
  chatModes: vi.fn(),
  settings: vi.fn()
}))

;(window as unknown as { api: unknown }).api = {
  localTools: {
    desktopApps: api.desktopApps,
    desktopAppConnect: api.desktopAppConnect,
    desktopAppRunning: api.desktopAppRunning,
    engineLoginCancel: api.engineLoginCancel
  },
  engine: { defaultRuntime: api.defaultRuntime },
  chatModes: { list: api.chatModes },
  providers: { onAccountConfigSynced: () => () => {} },
  settings: { getAll: api.settings }
}

const { DesktopAppsBanner } = await import('./DesktopAppsBanner')
const { useDesktopAppsStore, DESKTOP_APPS_DISMISSED_KEY } = await import('../../stores/desktopApps.store')

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DesktopAppsBanner />
    </QueryClientProvider>
  )
}

const region = () => screen.queryByRole('region', { name: 'Detected apps' })

beforeEach(() => {
  localStorage.clear()
  useDesktopAppsStore.setState({ dismissed: [] })
  api.desktopApps.mockReset().mockResolvedValue([claude])
  api.desktopAppConnect.mockReset()
  api.desktopAppRunning.mockReset().mockResolvedValue(null)
  api.engineLoginCancel.mockClear()
  api.defaultRuntime.mockReset().mockResolvedValue({ engine: 'opencode' })
  api.chatModes.mockReset().mockResolvedValue([])
  api.settings.mockReset().mockResolvedValue({ prioritizeAccountDefaults: false })
})

describe('DesktopAppsBanner', () => {
  it('offers one detected app with its sentence and button', async () => {
    mount()
    await waitFor(() => expect(region()).not.toBeNull())
    expect(screen.getByText("Claude Desktop is installed — use your Claude subscription as Cinna's default for chats and agents.")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use Claude' })).toBeTruthy()
  })

  it('offers two apps side by side', async () => {
    api.desktopApps.mockResolvedValue([claude, chatgpt])
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use ChatGPT' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Use Claude' })).toBeTruthy()
    expect(screen.getByText(/Claude Desktop and ChatGPT are installed/)).toBeTruthy()
  })

  it('renders nothing for an app that is already the default runtime', async () => {
    api.defaultRuntime.mockResolvedValue({ engine: 'claude' })
    mount()
    await waitFor(() => expect(api.defaultRuntime).toHaveBeenCalled())
    await act(async () => {})
    expect(region()).toBeNull()
  })

  it('X dismisses every offered app, for good', async () => {
    api.desktopApps.mockResolvedValue([claude, chatgpt])
    mount()
    await waitFor(() => expect(region()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(region()).toBeNull()
    expect(JSON.parse(localStorage.getItem(DESKTOP_APPS_DISMISSED_KEY)!)).toEqual(['claude-desktop', 'chatgpt'])
  })

  it('shows the phase in the pressed button, offers Cancel while signing in, and goes away once enabled', async () => {
    api.desktopApps.mockResolvedValue([claude, chatgpt])
    let finish!: (result: DesktopAppConnectResult) => void
    api.desktopAppConnect.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    mount()
    await waitFor(() => expect(region()).not.toBeNull())
    api.desktopAppRunning.mockResolvedValue({ appId: 'claude-desktop', phase: 'signing-in' })
    fireEvent.click(screen.getByRole('button', { name: 'Use Claude' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in in your browser…' })).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Use ChatGPT' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.engineLoginCancel).toHaveBeenCalledWith('claude')

    api.desktopAppRunning.mockResolvedValue(null)
    await act(async () => finish({ outcome: 'enabled' }))
    await waitFor(() => expect(region()).toBeNull())
    expect(api.desktopAppConnect).toHaveBeenCalledWith('claude-desktop')
    expect(useDesktopAppsStore.getState().dismissed).toEqual(['claude-desktop', 'chatgpt'])
  })

  it('dismisses on success even after the banner unmounted mid-connect', async () => {
    let finish!: (result: DesktopAppConnectResult) => void
    api.desktopAppConnect.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const view = mount()
    await waitFor(() => expect(region()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Use Claude' }))
    await waitFor(() => expect(api.desktopAppConnect).toHaveBeenCalled())
    view.unmount()
    await act(async () => finish({ outcome: 'enabled' }))
    await waitFor(() => expect(useDesktopAppsStore.getState().dismissed).toEqual(['claude-desktop']))
  })

  it('keeps the banner and says why when the connect fails', async () => {
    api.desktopAppConnect.mockResolvedValue({ outcome: 'failed', reason: 'Claude Code could not be installed.' })
    mount()
    await waitFor(() => expect(region()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Use Claude' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Claude Code could not be installed.'))
    expect(region()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Use Claude' })).toBeTruthy()
  })

  it('says nothing when the sign-in was cancelled', async () => {
    api.desktopAppConnect.mockResolvedValue({ outcome: 'cancelled' })
    mount()
    await waitFor(() => expect(region()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Use Claude' }))
    await waitFor(() => expect(api.desktopAppConnect).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(region()).not.toBeNull()
  })

  it('picks up a connect already running when it mounts', async () => {
    api.desktopAppRunning.mockResolvedValue({ appId: 'claude-desktop', phase: 'installing' })
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Installing…' })).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('hides an app whose engine chats and agents already run on', async () => {
    api.defaultRuntime.mockResolvedValue({ engine: 'claude' })
    mount()
    await waitFor(() => expect(api.chatModes).toHaveBeenCalled())
    await act(async () => {})
    expect(region()).toBeNull()
  })

  it('still offers Claude when the Default runtime is Claude but the default chat mode runs on an API key', async () => {
    api.defaultRuntime.mockResolvedValue({ engine: 'claude' })
    api.chatModes.mockResolvedValue([
      { id: 'm1', name: 'Default', isDefault: true, managed: false, enabled: true, engine: 'opencode', providerId: 'p1' }
    ])
    mount()
    await waitFor(() => expect(region()).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Use Claude' })).toBeTruthy()
  })
})
