import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../../stores/ui.store'

/**
 * Settings → Local Agents, the shape of its cards: under every control there
 * is a one-line status that is filled in every state, or a message rendered
 * only while it applies, last in its card — and never an empty slot. The
 * standing explanations are behind the `(?)` tips (ux_rules rules 1 and 12).
 */

const mutation = (): { mutate: ReturnType<typeof vi.fn>; isPending: boolean; variables: undefined } => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined
})

const HEALTHY_SETTINGS = {
  localAgentsDefaultEngine: 'opencode',
  localAgentsEnginePath: '',
  localAgentsDefaultCredentialId: '',
  taskRunnerConcurrency: 2
}
const READY_BINARY = {
  state: 'ready',
  path: '/usr/local/bin/opencode',
  source: 'path',
  version: '1.2.3'
}
let appSettings: Record<string, unknown> = HEALTHY_SETTINGS
let binary: Record<string, unknown> = READY_BINARY
let providers: Array<Record<string, unknown>> = []
/** The managed Codex CLI's state, and the section-owned mutation that installs or retries it. */
let codexBinary: Record<string, unknown> | undefined = { state: 'unresolved' }
let claudeBinary: Record<string, unknown> | undefined = { state: 'unresolved' }
let antigravityBinary: Record<string, unknown> | undefined = { state: 'unresolved' }
let antigravityAuth: Record<string, unknown> | undefined = { state: 'logged_in' }
let claudeAuth: Record<string, unknown> | undefined = { state: 'logged_in' }
let codexAuth: Record<string, unknown> | undefined = { state: 'logged_in' }
/** Which engine logins main reports running (`useEngineLoginRunning`). */
let loginRunning: Record<string, string | null> = { claude: null, codex: null, antigravity: null }
/** Which engines' auth was asked, by the `enabled` each hook was given. */
const authAsked = vi.fn((_engine: string, _enabled: boolean) => {})
/** Main's runtime setup: what the renderer asked for, and what it answers. */
const runtimeSetup = vi.fn(async (_engine: string, _options: { install: boolean }) => ({ outcome: 'ready' }))
const runtimeSetupCancel = vi.fn(async (_engine: string) => true)
let setupRunning: Record<string, string | null> = { claude: null, codex: null, antigravity: null }

/** Let queued mutation functions and query fetches run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

/** Every render gets a fresh query client: the setup hook keeps its phases there. */
function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return rtlRender(ui, { wrapper })
}

beforeEach(() => {
  claudeAuth = { state: 'logged_in' }
  codexAuth = { state: 'logged_in' }
  loginRunning = { claude: null, codex: null, antigravity: null }
  setupRunning = { claude: null, codex: null, antigravity: null }
  authAsked.mockClear()
  runtimeSetup.mockClear()
  runtimeSetupCancel.mockClear()
  Object.assign(window, {
    api: {
      localTools: {
        runtimeSetup,
        runtimeSetupCancel,
        runtimeSetupRunning: async () => setupRunning
      },
      system: { openExternal: vi.fn(async () => ({ success: true })) }
    }
  })
  appSettings = HEALTHY_SETTINGS
  binary = READY_BINARY
  codexBinary = { state: 'unresolved' }
  claudeBinary = { state: 'unresolved' }
  antigravityBinary = { state: 'unresolved' }
  antigravityAuth = { state: 'logged_in' }
  providers = []
  setAppSetting.mockReset()
  useUIStore.setState({ settingsTab: 'local-agents' })
})

vi.mock('../../hooks/useLocalAgents', () => ({
  useAddAgentRoot: mutation,
  useAgentsHome: () => ({ data: { path: '/home/dev/Agents', guarded: false } }),
  useLocalAgents: () => ({ data: { roots: [], homeAccess: 'ready' }, isLoading: false }),
  useRemoveAgentRoot: mutation,
  useRescanLocalAgents: mutation
}))
vi.mock('../../hooks/useLocalTools', () => ({
  CLAUDE_AUTH_KEY: ['claude-auth'],
  CODEX_AUTH_KEY: ['codex-auth'],
  ANTIGRAVITY_AUTH_KEY: ['antigravity-auth'],
  ENGINE_LOGIN_RUNNING_KEY: ['engine-login-running'],
  useClaudeAuth: ({ enabled }: { enabled: boolean }) => (authAsked('claude', enabled), { data: enabled ? claudeAuth : undefined }),
  useCodexAuth: ({ enabled }: { enabled: boolean }) => (authAsked('codex', enabled), { data: enabled ? codexAuth : undefined }),
  useAntigravityAuth: ({ enabled }: { enabled: boolean }) => (authAsked('antigravity', enabled), { data: enabled ? antigravityAuth : undefined }),
  useEngineLoginRunning: () => ({ data: loginRunning }),
  useDefaultTool: () => ({ tool: null, launchable: [] }),
  useInstallRuntimeTool: mutation,
  useLocalTools: () => ({ data: [] }),
  useOpenIn: mutation,
  useRefreshLocalTools: mutation,
  useSetDefaultTool: () => vi.fn(),
  useToolInstallPlans: () => ({ data: [] })
}))
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: providers }) }))
vi.mock('../../hooks/useChatModes', () => ({
  useDefaultChatMode: () => ({ data: { name: 'Personal' } })
}))
vi.mock('../../hooks/useEngine', () => ({
  useEngineBinary: () => ({ data: binary }),
  useResolveEngineBinary: mutation,
  useCodexBinary: () => ({ data: codexBinary }),
  useClaudeBinary: () => ({ data: claudeBinary }),
  useAntigravityBinary: () => ({ data: antigravityBinary })
}))
const setAppSetting = vi.fn()
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings, isError: false }),
  useSetAppSetting: () => ({ mutate: setAppSetting, isPending: false, variables: undefined })
}))

const { LocalAgentsSettingsSection } = await import('./LocalAgentsSettingsSection')

describe('LocalAgentsSettingsSection', () => {
  it('says opencode once for a 2.x version line, which names it already', () => {
    binary = { ...READY_BINARY, version: 'opencode v2.0.27' }
    render(<LocalAgentsSettingsSection />)
    expect(screen.getByText('Ready — opencode v2.0.27, your own installation.')).toBeTruthy()
  })

  it('reports the ready binary on one line and renders no credential or path message when healthy', () => {
    render(<LocalAgentsSettingsSection />)

    expect(screen.getByText('Ready — opencode 1.2.3, your own installation.')).toBeTruthy()
    expect(screen.queryByText(/agents pinned to it will not run/)).toBeNull()
    expect(screen.queryByText(/default chat mode\.$/)).toBeNull()
    expect(screen.queryByText(/Used from the next agent run/)).toBeNull()
  })

  it('warns about a switched-off pinned credential without claiming a fallback', () => {
    appSettings = { ...appSettings, localAgentsDefaultCredentialId: 'p1' }
    providers = [{ id: 'p1', name: 'Team', type: 'openai', enabled: false, hasApiKey: true }]
    render(<LocalAgentsSettingsSection />)

    // The name is the part that may truncate; the sentence never does.
    const sentence = screen.getByText('is switched off — agents pinned to it will not run.')
    expect(sentence.parentElement?.textContent).toBe(
      'Team is switched off — agents pinned to it will not run.'
    )
    expect(sentence.previousElementSibling?.className).toContain('truncate')
  })

  it('reports a failed resolve in the danger tone, with Try again beside it', () => {
    binary = { state: 'failed', error: 'opencode could not be downloaded.' }
    render(<LocalAgentsSettingsSection />)

    const status = screen.getByText('opencode could not be downloaded.')
    expect(status.className).toContain('text-[var(--color-danger)]')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  describe('with Codex as the default runtime', () => {
    beforeEach(() => {
      appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex' }
    })

    it('names the managed pinned version once it is installed, muted and with no action', () => {
      codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.162.1/codex', source: 'managed', version: 'codex-cli 0.162.1' }
      render(<LocalAgentsSettingsSection />)

      const status = screen.getByText('Codex 0.162.1 (managed) — runs on your Codex login.')
      expect(status.className).toContain('text-[var(--color-text-muted)]')
      expect(screen.queryByRole('button', { name: /Try again|Install now|Installing/ })).toBeNull()
      // The OpenCode binary is not a fact about a machine running Codex (rule 9).
      expect(screen.queryByText(/opencode 1\.2\.3/)).toBeNull()
    })

    it('labels an explicit Codex path unverified, by its own version', () => {
      codexBinary = { state: 'ready', path: '/opt/codex', source: 'configured', version: 'codex-cli 0.156.0' }
      render(<LocalAgentsSettingsSection />)

      expect(screen.getByText('Unverified Codex 0.156.0 — your configured path.')).toBeTruthy()
      expect(screen.queryByText(/managed\)/)).toBeNull()
    })

    it('says the same on the Codex button as in the line under it', () => {
      // Mutation: drop `codexBinary` from the picker and the button reads
      // `0.162.1 managed` directly above "Unverified Codex 0.156.0".
      codexBinary = { state: 'ready', path: '/opt/codex', source: 'configured', version: 'codex-cli 0.156.0' }
      const view = render(<LocalAgentsSettingsSection />)
      const button = screen.getByRole('button', { name: /^Codex/ })
      expect(button.textContent).toBe('Codex0.156.0 unverified')

      codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.162.1/codex', source: 'managed', version: 'codex-cli 0.162.1' }
      view.rerender(<LocalAgentsSettingsSection />)
      expect(screen.getByRole('button', { name: /^Codex/ }).textContent).toBe('Codex0.162.1 managed')
    })

    it('leaves a failed install by itself when a saved Codex Path resolves, in the same one-line slot', () => {
      // Main re-resolves on save and pushes each state; nothing here is clicked.
      codexBinary = { state: 'failed', error: 'Codex could not be downloaded. Check your connection and try again.' }
      const view = render(<LocalAgentsSettingsSection />)
      const slot = screen.getByText(/could not be downloaded/).parentElement!
      expect(slot.className).toContain('min-h-[1lh]')
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()

      appSettings = { ...appSettings, localAgentsCodexPath: '/opt/codex' }
      codexBinary = { state: 'resolving' }
      view.rerender(<LocalAgentsSettingsSection />)
      // Checking the user's file is not a 90 MB install, and must not say so.
      const checking = screen.getByText('Checking your configured Codex path…')
      expect(checking.parentElement).toBe(slot)
      expect(checking.className).toContain('text-[var(--color-text-muted)]')
      expect(screen.queryByText(/about 90 MB/)).toBeNull()

      codexBinary = { state: 'ready', path: '/opt/codex', source: 'configured', version: 'codex-cli 0.156.0' }
      view.rerender(<LocalAgentsSettingsSection />)
      const ready = screen.getByText('Unverified Codex 0.156.0 — your configured path.')
      expect(ready.parentElement).toBe(slot)
      expect(ready.className).not.toContain('text-[var(--color-danger)]')
      expect(screen.queryByRole('button', { name: /Try again|Retry/ })).toBeNull()
    })

    it('puts Install on the card while nothing is fetched, without an alarm, and the chip installs through main', async () => {
      codexBinary = { state: 'unresolved', assetBytes: 90 * 1024 * 1024 + 700_000 }
      render(<LocalAgentsSettingsSection />)

      const status = screen.getByText('Codex 0.162.1 installs on first use, about 90 MB.')
      expect(status.className).toContain('text-[var(--color-text-muted)]')
      // The action is on the card now, not in the line.
      expect(screen.queryByRole('button', { name: 'Install now' })).toBeNull()
      expect(status.parentElement!.querySelector('button')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Install' }))
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('codex', { install: true, login: 'auto' }))
      expect(runtimeSetup).toHaveBeenCalledTimes(1)
    })

    it('shows download progress in the same one line, and the card overlay holds the percentage', () => {
      codexBinary = { state: 'resolving', received: 45 * 1024 * 1024, total: 90 * 1024 * 1024 }
      render(<LocalAgentsSettingsSection />)

      const status = screen.getByText('Downloading Codex 0.162.1 — 45 of 90 MB.')
      // The slot that holds every other state, so a moving number moves nothing.
      expect(status.className).toContain('truncate')
      expect(status.parentElement?.className).toContain('min-h-[1lh]')
      expect(screen.getByRole('status').textContent).toBe('Installing 50%')
      expect(screen.queryByRole('button', { name: /^(Install|Retry)$/ })).toBeNull()
      // The card says what is happening while the chip counts.
      expect(screen.getByRole('button', { name: /^Codex/ }).textContent).toBe('CodexInstalling…')
    })

    it('reports a failed install in the danger tone with Retry on the card, and closes nothing', async () => {
      codexBinary = { state: 'failed', error: 'The downloaded Codex did not match its expected checksum, so it was discarded.' }
      render(<LocalAgentsSettingsSection />)

      const status = screen.getByText(/did not match its expected checksum/)
      expect(status.className).toContain('text-[var(--color-danger)]')
      expect(status.getAttribute('title')).toContain('did not match its expected checksum')
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('codex', { install: true, login: 'auto' }))
      // The picker is still there to choose another runtime from (rule 6).
      expect(screen.getByRole('button', { name: /Custom OpenCode/ })).toBeTruthy()
    })

    it('a signed-out Codex: Log in on the card, the line says so, and the chip starts the setup without an install', async () => {
      codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.162.1/codex', source: 'managed', version: 'codex-cli 0.162.1' }
      codexAuth = { state: 'logged_out' }
      render(<LocalAgentsSettingsSection />)
      expect(screen.getByText('Codex is not logged in.').className).toContain('text-[var(--color-danger)]')
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('codex', { install: false, login: 'force' }))
    })

    it('a visit never starts a setup, and an unknown login offers no Log in', async () => {
      codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.162.1/codex', source: 'managed', version: 'codex-cli 0.162.1' }
      codexAuth = { state: 'unknown' }
      render(<LocalAgentsSettingsSection />)
      expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull()
      await settle()
      expect(runtimeSetup).not.toHaveBeenCalled()
      // Only the selected engine's login is asked.
      expect(authAsked).toHaveBeenCalledWith('codex', true)
      expect(authAsked).not.toHaveBeenCalledWith('claude', true)
      expect(authAsked).not.toHaveBeenCalledWith('antigravity', true)
    })

    it('says nothing while the state is still being read', () => {
      codexBinary = undefined
      render(<LocalAgentsSettingsSection />)

      expect(screen.queryByText(/Codex 0\.155\.0 (downloads|\(managed)/)).toBeNull()
    })

    it('selecting a card that is not on disk only selects it: no download, no setup, no install dialog', async () => {
      appSettings = HEALTHY_SETTINGS
      render(<LocalAgentsSettingsSection />)

      const codex = screen.getByRole('button', { name: /^Codex/ })
      expect(codex.textContent).toBe('CodexNot installed')
      // Unselected: no chip.
      expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
      fireEvent.click(codex)
      expect(setAppSetting).toHaveBeenCalledWith({ key: 'localAgentsDefaultEngine', value: 'codex' })
      // A mutation's function runs a tick after `mutate`: let it, then look.
      await settle()
      expect(runtimeSetup).not.toHaveBeenCalledWith('codex', expect.objectContaining({ install: true }))
      expect(runtimeSetup).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('selecting an installed card asks main to check its sign-in, never to install', async () => {
      appSettings = HEALTHY_SETTINGS
      codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.162.1/codex', source: 'managed', version: 'codex-cli 0.162.1' }
      render(<LocalAgentsSettingsSection />)
      fireEvent.click(screen.getByRole('button', { name: /^Codex/ }))
      expect(setAppSetting).toHaveBeenCalledWith({ key: 'localAgentsDefaultEngine', value: 'codex' })
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('codex', { install: false, login: 'auto' }))
    })
  })

  describe('with Claude Agent as the default runtime', () => {
    const MANAGED = { state: 'ready', path: '/data/runtimes/claude-2.1.296/claude', source: 'managed', version: '2.1.296 (Claude Code)' }
    beforeEach(() => {
      appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'claude' }
    })

    it('reports the pinned CLI, not PATH detection: no "not found" alarm on a machine with no claude', async () => {
      // Mutation: read `useLocalTools` for this line again and a machine Cinna
      // would simply install Claude Code on is told its agents cannot run.
      claudeBinary = { state: 'unresolved', assetBytes: 215_643_408 }
      render(<LocalAgentsSettingsSection />)
      const status = screen.getByText('Claude Code 2.1.296 installs on first use, about 215 MB.')
      expect(status.className).toContain('text-[var(--color-text-muted)]')
      expect(status.parentElement!.className).toContain('min-h-[1lh]')
      expect(screen.queryByText(/not found/i)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Install' }))
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('claude', { install: true, login: 'auto' }))
    })

    it.each([
      ['a managed copy', MANAGED, 'Claude Code 2.1.296 (managed) — runs on your Claude login.', 'Claude Agent2.1.296 managed'],
      ['the user’s install at exactly the pin', { ...MANAGED, source: 'path-pinned', path: '/Users/x/.local/bin/claude' },
        'Claude Code 2.1.296 — your own install, the tested version.', 'Claude Agent2.1.296 (your install)']
    ])('says the same on the button as in the line under it: %s', (_label, state, line, button) => {
      claudeBinary = state
      render(<LocalAgentsSettingsSection />)
      expect(screen.getByText(line).className).toContain('text-[var(--color-text-muted)]')
      expect(screen.getByRole('button', { name: /^Claude Agent/ }).textContent).toBe(button)
      // Healthy: nothing to press.
      expect(screen.queryByRole('button', { name: /^(Try again|Install|Retry|Sign in)$/ })).toBeNull()
    })

    it('shows the 215 MB download in the same one line, with the overlay showing progress rather than an action', () => {
      claudeBinary = { state: 'resolving', received: 107_821_704, total: 215_643_408, assetBytes: 215_643_408 }
      render(<LocalAgentsSettingsSection />)
      const status = screen.getByText('Downloading Claude Code 2.1.296 — 107 of 215 MB.')
      expect(status.parentElement!.className).toContain('min-h-[1lh]')
      expect(screen.getByRole('status').textContent).toBe('Installing 50%')
      expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    })

    it('a logged-out Claude Code now says so in Settings, with Log in on its card', async () => {
      claudeBinary = MANAGED
      claudeAuth = { state: 'logged_out' }
      render(<LocalAgentsSettingsSection />)
      expect(screen.getByText('Claude Code is not logged in.').className).toContain('text-[var(--color-danger)]')
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('claude', { install: false, login: 'force' }))
    })

    it('a login running in main: a spinner on the card, the phase in the line, and Cancel ends the setup', () => {
      claudeBinary = MANAGED
      claudeAuth = { state: 'logged_out' }
      loginRunning = { claude: 'waiting', codex: null, antigravity: null }
      render(<LocalAgentsSettingsSection />)
      expect(screen.getByRole('status').textContent).toBe('Logging in…')
      expect(screen.getByRole('button', { name: /^Claude Agent/ }).textContent).toBe('Claude AgentLogging in…')
      expect(screen.getByText('Waiting for sign-in in your browser…')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(runtimeSetupCancel).toHaveBeenCalledWith('claude')
    })

    it('a failed Claude Path reads Unavailable on the button — never "<pin> managed" above a red line about the user’s own file', async () => {
      appSettings = { ...appSettings, localAgentsClaudePath: '/opt/claude' }
      claudeBinary = { state: 'failed', error: 'Claude path will not run — fix it in Local Development.' }
      render(<LocalAgentsSettingsSection />)
      const status = screen.getByText('Claude path will not run — fix it in Local Development.')
      expect(status.className).toContain('text-[var(--color-danger)]')
      expect(screen.getByRole('button', { name: /^Claude Agent/ }).textContent).toBe('Claude AgentUnavailable')
      // Not *Retry*: it would re-check the same bad path. The field is on
      // another tab, so the action goes there.
      expect(screen.queryByRole('button', { name: /^(Try again|Install|Retry)$/ })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Fix path' }))
      expect(useUIStore.getState().settingsTab).toBe('local-dev')
      await settle()
      expect(runtimeSetup).not.toHaveBeenCalledWith('claude', expect.objectContaining({ install: true }))
      // Closes nothing: another runtime is still one click away (rule 6).
      expect(screen.getByRole('button', { name: /Custom OpenCode/ })).toBeTruthy()
    })

    it('does not offer Install now beside a saved path that simply has not been checked yet', () => {
      appSettings = { ...appSettings, localAgentsClaudePath: '/opt/claude' }
      claudeBinary = { state: 'unresolved' }
      render(<LocalAgentsSettingsSection />)
      expect(screen.getByText('Your configured Claude path is checked on first use.')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
      expect(screen.getByRole('button', { name: /^Claude Agent/ }).textContent).toBe('Claude Agentunverified')
    })

    it('says nothing while the state is still being read', () => {
      claudeBinary = undefined
      render(<LocalAgentsSettingsSection />)
      expect(screen.queryByText(/Claude Code 2\.1\.296/)).toBeNull()
    })
  })

  it('the Codex button too reads Unavailable when a saved Codex Path failed', () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex', localAgentsCodexPath: '/opt/codex' }
    codexBinary = { state: 'failed', error: 'Codex path will not run — fix it in Local Development.' }
    render(<LocalAgentsSettingsSection />)
    expect(screen.getByRole('button', { name: /^Codex/ }).textContent).toBe('CodexUnavailable')
    expect(screen.queryByRole('button', { name: /^(Try again|Install|Retry)$/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fix path' }))
    expect(useUIStore.getState().settingsTab).toBe('local-dev')
  })

  it('the Codex row agrees with the Claude row: no Install now beside a saved, unchecked path', () => {
    // Mutation: drop `pathSet` from the chip rule and "Install" sits on the
    // card above "Your configured Codex path is checked on first use."
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex', localAgentsCodexPath: '/opt/codex' }
    codexBinary = { state: 'unresolved' }
    render(<LocalAgentsSettingsSection />)
    expect(screen.getByText('Your configured Codex path is checked on first use.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('a failed managed install still offers Retry, on the card', async () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex' }
    codexBinary = { state: 'failed', error: 'offline' }
    render(<LocalAgentsSettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('codex', { install: true, login: 'auto' }))
  })

  it('an install that failed where the binary state does not say so still shows its reason, in the danger tone', async () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex' }
    codexBinary = { state: 'unresolved' }
    runtimeSetup.mockResolvedValueOnce({ outcome: 'install_failed', reason: 'Could not look for Codex.' } as never)
    render(<LocalAgentsSettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    const line = await screen.findByText('Could not look for Codex.')
    expect(line.className).toContain('text-[var(--color-danger)]')
  })

  it('a cancelled login leaves the line agreeing with the Log in chip', async () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex' }
    codexBinary = { state: 'ready', path: '/c', source: 'managed', version: 'codex-cli 0.162.1' }
    codexAuth = { state: 'logged_out' }
    runtimeSetup.mockResolvedValueOnce({ outcome: 'cancelled' } as never)
    render(<LocalAgentsSettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(runtimeSetup).toHaveBeenCalled())
    await settle()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy()
    expect(screen.getByText('Codex is not logged in.')).toBeTruthy()
  })

  it('the green dot only when installed and logged in; an unknown login claims nothing', () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex' }
    codexBinary = { state: 'ready', path: '/c', source: 'managed', version: 'codex-cli 0.162.1' }
    codexAuth = { state: 'logged_in' }
    const view = render(<LocalAgentsSettingsSection />)
    expect(screen.getByRole('img', { name: 'Ready' })).toBeTruthy()
    codexAuth = { state: 'unknown' }
    view.rerender(<LocalAgentsSettingsSection />)
    expect(screen.queryByRole('img', { name: 'Ready' })).toBeNull()
    expect(document.querySelector('.runtime-card-scrim')).toBeNull()
  })

  it('Custom OpenCode with a usable credential is all set: the dot', () => {
    providers = [{ id: 'p1', name: 'Team', type: 'openai', enabled: true, hasApiKey: true }]
    render(<LocalAgentsSettingsSection />)
    expect(screen.getByRole('img', { name: 'Ready' })).toBeTruthy()
  })

  it('a visit to Antigravity whose login is still loading shows the normal line, not the terms', () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'antigravity' }
    antigravityBinary = { state: 'ready', path: '/x/agy_acp_server.par', source: 'managed', version: null }
    antigravityAuth = undefined
    render(<LocalAgentsSettingsSection />)
    expect(screen.getByText(/^Antigravity \S+ \(managed\) — runs on your Google login\.$/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Google’s Antigravity terms' })).toBeNull()
  })

  it('Custom OpenCode with no AI credential: Add credential on the card opens AI Credentials', () => {
    providers = []
    render(<LocalAgentsSettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Add credential' }))
    expect(useUIStore.getState().settingsTab).toBe('llm')
  })

  it('Custom OpenCode with a usable credential carries no chip', () => {
    providers = [{ id: 'p1', name: 'Team', type: 'openai', enabled: true, hasApiKey: true }]
    render(<LocalAgentsSettingsSection />)
    expect(screen.queryByRole('button', { name: 'Add credential' })).toBeNull()
  })

  it('the end of a setup, seen through the mutation, leaves a failed login in the line', async () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'claude' }
    claudeBinary = { state: 'ready', path: '/c', source: 'managed', version: '2.1.296 (Claude Code)' }
    claudeAuth = { state: 'logged_out' }
    runtimeSetup.mockResolvedValueOnce({ outcome: 'login_failed', login: { outcome: 'timeout', command: null } } as never)
    render(<LocalAgentsSettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    await waitFor(() => expect(screen.getByText('Sign-in timed out.')).toBeTruthy())
  })

  it('says a vanished pin falls through to the chat mode, and only then', () => {
    appSettings = { ...appSettings, localAgentsDefaultCredentialId: 'gone' }
    providers = []
    render(<LocalAgentsSettingsSection />)

    expect(
      screen.getByText('Pinned credential is gone — agents use your default chat mode.')
    ).toBeTruthy()
  })

  it('keeps the Open agents with explanation behind its tip', () => {
    render(<LocalAgentsSettingsSection />)

    expect(screen.queryByText(/Open-in button uses this tool/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'About Open agents with' }))
    expect(screen.getByText(/Open-in button uses this tool/)).toBeTruthy()
    expect(screen.getByLabelText('Open agents with').tagName).toBe('SELECT')
  })

  describe('with Antigravity as the default runtime', () => {
    const MAC_BYTES = 111_456_962
    beforeEach(() => {
      appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'antigravity' }
    })

    it('is a picker button beside Codex, and its line names the managed pin with no action', () => {
      antigravityBinary = { state: 'ready', path: '/data/runtimes/antigravity-1.3.0/agy_acp_server.par', source: 'managed', version: null }
      render(<LocalAgentsSettingsSection />)
      const button = screen.getByRole('button', { name: /^Antigravity/ })
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(button.textContent).toMatch(/managed$/)
      const status = screen.getByText(/^Antigravity \S+ \(managed\) — runs on your Google login\.$/)
      expect(status.className).toContain('text-[var(--color-text-muted)]')
      expect(screen.queryByRole('button', { name: /^(Try again|Install|Retry|Sign in)$/ })).toBeNull()
      expect(screen.queryByText(/Google’s software/)).toBeNull()
      // Signed in: the normal status, no terms.
      expect(screen.queryByRole('button', { name: 'Google’s Antigravity terms' })).toBeNull()
      // Only asks the login of the runtime this row shows.
      expect(authAsked).toHaveBeenCalledWith('antigravity', true)
    })

    it('not installed: Install on the card, and the line names Google’s terms with the link', async () => {
      antigravityBinary = { state: 'unresolved', assetBytes: MAC_BYTES }
      render(<LocalAgentsSettingsSection />)
      const terms = screen.getByRole('button', { name: 'Google’s Antigravity terms' })
      const line = terms.closest('p')!
      expect(line.textContent).toBe('Installing and logging in accepts Google’s Antigravity terms')
      expect(line.parentElement!.className).toContain('min-h-[1lh]')
      fireEvent.click(terms)
      expect(window.api.system.openExternal).toHaveBeenCalledWith('https://antigravity.google/terms')
      fireEvent.click(screen.getByRole('button', { name: 'Install' }))
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('antigravity', { install: true, login: 'auto' }))
    })

    it('while signed out: Log in on the card, the line says so with the terms behind a (?)', async () => {
      antigravityBinary = { state: 'ready', path: '/x/agy_acp_server.par', source: 'managed', version: null }
      antigravityAuth = { state: 'logged_out' }
      render(<LocalAgentsSettingsSection />)
      const status = screen.getByText('Antigravity is not logged in.')
      expect(status.className).toContain('text-[var(--color-danger)]')
      // One line: the status and the (?) share the reserved row, and nothing
      // is rendered after it.
      const tip = screen.getByRole('button', { name: 'About Antigravity’s terms' })
      const line = status.parentElement!
      expect(line.contains(tip)).toBe(true)
      expect(line.nextElementSibling).toBeNull()
      // Log in is the card's chip, not a second action in the line.
      expect(line.contains(screen.getByRole('button', { name: 'Log in' }))).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('antigravity', { install: false, login: 'force' }))
    })

    it('says the browser wait in the same line, with Cancel, and keeps the (?) so nothing moves', () => {
      antigravityBinary = { state: 'ready', path: '/x/agy_acp_server.par', source: 'managed', version: null }
      antigravityAuth = { state: 'logged_out' }
      loginRunning = { claude: null, codex: null, antigravity: 'waiting' }
      render(<LocalAgentsSettingsSection />)
      const status = screen.getByText('Waiting for sign-in in your browser…')
      expect(status.parentElement!.contains(screen.getByRole('button', { name: 'About Antigravity’s terms' }))).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(runtimeSetupCancel).toHaveBeenCalledWith('antigravity')
    })

    it('a failed install outranks the login: Retry, not Log in', async () => {
      antigravityBinary = { state: 'failed', error: 'Antigravity could not be downloaded.' }
      antigravityAuth = { state: 'logged_out' }
      render(<LocalAgentsSettingsSection />)
      expect(screen.getByText('Antigravity could not be downloaded.').className).toContain('text-[var(--color-danger)]')
      expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('antigravity', { install: true, login: 'auto' }))
    })
  })
})
