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
  providers: vi.fn(),
  claudeAuth: vi.fn(),
  codexAuth: vi.fn(),
  claudeBinary: vi.fn(),
  codexBinary: vi.fn(),
  tools: vi.fn()
}))

;(window as unknown as { api: unknown }).api = {
  localTools: {
    desktopApps: api.desktopApps,
    desktopAppConnect: api.desktopAppConnect,
    desktopAppRunning: api.desktopAppRunning,
    engineLoginCancel: api.engineLoginCancel,
    claudeAuth: api.claudeAuth,
    codexAuth: api.codexAuth,
    list: api.tools
  },
  engine: { defaultRuntime: api.defaultRuntime, claudeBinary: api.claudeBinary, codexBinary: api.codexBinary },
  providers: { list: api.providers, onAccountConfigSynced: () => () => {} }
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

/**
 * Wait until every fact the banner decides on has been asked for and answered,
 * so "renders nothing" means the rule hid it, not that it was still loading.
 */
async function settle(): Promise<void> {
  for (const probe of [api.claudeAuth, api.codexAuth, api.claudeBinary, api.codexBinary, api.tools]) {
    await waitFor(() => expect(probe).toHaveBeenCalled())
  }
  for (let i = 0; i < 5; i++) await act(async () => {})
}

beforeEach(() => {
  localStorage.clear()
  useDesktopAppsStore.setState({ dismissed: [] })
  api.desktopApps.mockReset().mockResolvedValue([claude])
  api.desktopAppConnect.mockReset()
  api.desktopAppRunning.mockReset().mockResolvedValue(null)
  api.engineLoginCancel.mockClear()
  // A Mac with nothing working: no credential, no CLI (whose probe then says unknown).
  api.defaultRuntime.mockReset().mockResolvedValue({ engine: 'opencode' })
  api.providers.mockReset().mockResolvedValue([])
  api.claudeAuth.mockReset().mockResolvedValue({ state: 'unknown', authMethod: null })
  api.codexAuth.mockReset().mockResolvedValue({ state: 'unknown' })
  api.claudeBinary.mockReset().mockResolvedValue({ state: 'unresolved' })
  api.codexBinary.mockReset().mockResolvedValue({ state: 'unresolved' })
  api.tools.mockReset().mockResolvedValue([])
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
  it('stays hidden while a CLI is signed in, even when chats run on an API key', async () => {
    api.desktopApps.mockResolvedValue([claude, chatgpt])
    api.defaultRuntime.mockResolvedValue({ engine: 'claude' })
    api.providers.mockResolvedValue([{ id: 'p1', type: 'anthropic', enabled: true, hasApiKey: true, unsupported: false }])
    api.claudeAuth.mockResolvedValue({ state: 'logged_in', authMethod: 'claude.ai' })
    api.claudeBinary.mockResolvedValue({ state: 'ready', path: '/x/claude', source: 'managed', version: '1' })
    mount()
    await settle()
    expect(region()).toBeNull()
  })

  it('stays hidden, and asks no CLI, when OpenCode has a credential to run on', async () => {
    api.providers.mockResolvedValue([{ id: 'p1', type: 'openai', enabled: true, hasApiKey: true, unsupported: false }])
    mount()
    await waitFor(() => expect(api.providers).toHaveBeenCalled())
    for (let i = 0; i < 5; i++) await act(async () => {})
    expect(region()).toBeNull()
    expect(api.claudeAuth).not.toHaveBeenCalled()
    expect(api.codexAuth).not.toHaveBeenCalled()
  })

  it('stays hidden when an installed CLI cannot say whether it is signed in', async () => {
    api.defaultRuntime.mockResolvedValue({ engine: 'claude' })
    api.claudeBinary.mockResolvedValue({ state: 'ready', path: '/x/claude', source: 'managed', version: '1' })
    mount()
    await settle()
    expect(region()).toBeNull()
  })

  it('stays hidden for a signed-in claude of its own on PATH, before the pinned copy exists', async () => {
    // The probe asks only the pinned binary, so it cannot tell yet.
    api.defaultRuntime.mockResolvedValue({ engine: 'claude' })
    api.tools.mockResolvedValue([{ id: 'claude', available: true }])
    mount()
    await settle()
    expect(region()).toBeNull()
  })

  it('stays hidden when an installed codex cannot say whether it is signed in', async () => {
    api.desktopApps.mockResolvedValue([claude, chatgpt])
    api.codexBinary.mockResolvedValue({ state: 'ready', path: '/x/codex', source: 'managed', version: '1' })
    mount()
    await settle()
    expect(region()).toBeNull()
  })

  it('keeps a running connect on screen even once its login counts as working', async () => {
    api.desktopAppRunning.mockResolvedValue({ appId: 'chatgpt', phase: 'checking' })
    api.desktopApps.mockResolvedValue([chatgpt])
    api.codexAuth.mockResolvedValue({ state: 'logged_in', method: 'chatgpt' })
    api.codexBinary.mockResolvedValue({ state: 'ready', path: '/x/codex', source: 'managed', version: '1' })
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Checking…' })).toBeTruthy())
  })

  it('offers when the Default runtime is a CLI that is signed out', async () => {
    api.defaultRuntime.mockResolvedValue({ engine: 'claude' })
    api.claudeAuth.mockResolvedValue({ state: 'logged_out', authMethod: 'none' })
    api.claudeBinary.mockResolvedValue({ state: 'ready', path: '/x/claude', source: 'managed', version: '1' })
    mount()
    await waitFor(() => expect(region()).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Use Claude' })).toBeTruthy()
  })

  it('offers when the only credential is switched off', async () => {
    api.providers.mockResolvedValue([{ id: 'p1', type: 'openai', enabled: false, hasApiKey: true, unsupported: false }])
    mount()
    await waitFor(() => expect(region()).not.toBeNull())
  })
})
