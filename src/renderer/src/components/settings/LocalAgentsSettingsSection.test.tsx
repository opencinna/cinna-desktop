import { fireEvent, render, screen } from '@testing-library/react'
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
let resolveCodex = mutation()
let claudeBinary: Record<string, unknown> | undefined = { state: 'unresolved' }
let resolveClaude = mutation()
beforeEach(() => {
  appSettings = HEALTHY_SETTINGS
  binary = READY_BINARY
  codexBinary = { state: 'unresolved' }
  resolveCodex = mutation()
  claudeBinary = { state: 'unresolved' }
  resolveClaude = mutation()
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
  useDefaultTool: () => ({ tool: null, launchable: [], autoOpen: false }),
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
  useResolveCodexBinary: () => resolveCodex,
  useClaudeBinary: () => ({ data: claudeBinary }),
  useResolveClaudeBinary: () => resolveClaude
}))
const setAppSetting = vi.fn()
vi.mock('../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ data: appSettings, isError: false }),
  useSetAppSetting: () => ({ mutate: setAppSetting, isPending: false, variables: undefined })
}))

const { LocalAgentsSettingsSection } = await import('./LocalAgentsSettingsSection')

describe('LocalAgentsSettingsSection', () => {
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
      codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.155.0/codex', source: 'managed', version: 'codex-cli 0.155.0' }
      render(<LocalAgentsSettingsSection />)

      const status = screen.getByText('Codex 0.155.0 (managed) — runs on your Codex login.')
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
      // `0.155.0 managed` directly above "Unverified Codex 0.156.0".
      codexBinary = { state: 'ready', path: '/opt/codex', source: 'configured', version: 'codex-cli 0.156.0' }
      const view = render(<LocalAgentsSettingsSection />)
      const button = screen.getByRole('button', { name: /^Codex/ })
      expect(button.textContent).toBe('Codex0.156.0 unverified')

      codexBinary = { state: 'ready', path: '/data/runtimes/codex-0.155.0/codex', source: 'managed', version: 'codex-cli 0.155.0' }
      view.rerender(<LocalAgentsSettingsSection />)
      expect(screen.getByRole('button', { name: /^Codex/ }).textContent).toBe('Codex0.155.0 managed')
    })

    it('leaves a failed install by itself when a saved Codex Path resolves, in the same one-line slot', () => {
      // Main re-resolves on save and pushes each state; nothing here is clicked.
      codexBinary = { state: 'failed', error: 'Codex could not be downloaded. Check your connection and try again.' }
      const view = render(<LocalAgentsSettingsSection />)
      const slot = screen.getByText(/could not be downloaded/).parentElement!
      expect(slot.className).toContain('min-h-[1lh]')
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()

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
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    })

    it('offers Install now while nothing is fetched, without an alarm, and installs on the click', () => {
      codexBinary = { state: 'unresolved', assetBytes: 90 * 1024 * 1024 + 700_000 }
      render(<LocalAgentsSettingsSection />)

      const status = screen.getByText('Codex 0.155.0 installs on first use, about 90 MB.')
      expect(status.className).toContain('text-[var(--color-text-muted)]')
      fireEvent.click(screen.getByRole('button', { name: 'Install now' }))
      expect(resolveCodex.mutate).toHaveBeenCalledTimes(1)
    })

    it('shows download progress in the same one line, with the action held while it runs', () => {
      codexBinary = { state: 'resolving', received: 45 * 1024 * 1024, total: 90 * 1024 * 1024 }
      resolveCodex = { ...mutation(), isPending: true }
      render(<LocalAgentsSettingsSection />)

      const status = screen.getByText('Downloading Codex 0.155.0 — 45 of 90 MB.')
      // The slot that holds every other state, so a moving number moves nothing.
      expect(status.className).toContain('truncate')
      expect(status.parentElement?.className).toContain('min-h-[1lh]')
      const action = screen.getByRole('button', { name: 'Installing…' }) as HTMLButtonElement
      expect(action.disabled).toBe(true)
    })

    it('reports a failed install in the danger tone with Try again, and closes nothing', () => {
      codexBinary = { state: 'failed', error: 'The downloaded Codex did not match its expected checksum, so it was discarded.' }
      render(<LocalAgentsSettingsSection />)

      const status = screen.getByText(/did not match its expected checksum/)
      expect(status.className).toContain('text-[var(--color-danger)]')
      expect(status.getAttribute('title')).toContain('did not match its expected checksum')
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(resolveCodex.mutate).toHaveBeenCalledTimes(1)
      // The picker is still there to choose another runtime from (rule 6).
      expect(screen.getByRole('button', { name: /Custom OpenCode/ })).toBeTruthy()
    })

    it('says nothing while the state is still being read', () => {
      codexBinary = undefined
      render(<LocalAgentsSettingsSection />)

      expect(screen.queryByText(/Codex 0\.155\.0 (downloads|\(managed)/)).toBeNull()
    })

    it('never offers to install a PATH copy: Codex is selectable with no codex detected', () => {
      appSettings = HEALTHY_SETTINGS
      render(<LocalAgentsSettingsSection />)

      const codex = screen.getByRole('button', { name: /^Codex/ })
      expect(codex.textContent).toContain('0.155.0 managed')
      expect(codex.textContent).not.toContain('Not installed')
      fireEvent.click(codex)
      expect(setAppSetting).toHaveBeenCalledWith({ key: 'localAgentsDefaultEngine', value: 'codex' })
    })
  })

  describe('with Claude Agent as the default runtime', () => {
    const MANAGED = { state: 'ready', path: '/data/runtimes/claude-2.1.276/claude', source: 'managed', version: '2.1.276 (Claude Code)' }
    beforeEach(() => {
      appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'claude' }
    })

    it('reports the pinned CLI, not PATH detection: no "not found" alarm on a machine with no claude', () => {
      // Mutation: read `useLocalTools` for this line again and a machine Cinna
      // would simply install Claude Code on is told its agents cannot run.
      claudeBinary = { state: 'unresolved', assetBytes: 215_643_408 }
      render(<LocalAgentsSettingsSection />)
      const status = screen.getByText('Claude Code 2.1.276 installs on first use, about 215 MB.')
      expect(status.className).toContain('text-[var(--color-text-muted)]')
      expect(status.parentElement!.className).toContain('min-h-[1lh]')
      expect(screen.queryByText(/not found/i)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Install now' }))
      expect(resolveClaude.mutate).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['a managed copy', MANAGED, 'Claude Code 2.1.276 (managed) — runs on your Claude login.', 'Claude Agent2.1.276 managed'],
      ['the user’s install at exactly the pin', { ...MANAGED, source: 'path-pinned', path: '/Users/x/.local/bin/claude' },
        'Claude Code 2.1.276 — your own install, the tested version.', 'Claude Agent2.1.276 (your install)']
    ])('says the same on the button as in the line under it: %s', (_label, state, line, button) => {
      claudeBinary = state
      render(<LocalAgentsSettingsSection />)
      expect(screen.getByText(line).className).toContain('text-[var(--color-text-muted)]')
      expect(screen.getByRole('button', { name: /^Claude Agent/ }).textContent).toBe(button)
      // Healthy: nothing to press.
      expect(screen.queryByRole('button', { name: /Try again|Install now/ })).toBeNull()
    })

    it('shows the 215 MB download in the same one line, with the action held while it runs', () => {
      claudeBinary = { state: 'resolving', received: 107_821_704, total: 215_643_408, assetBytes: 215_643_408 }
      resolveClaude = { ...mutation(), isPending: true }
      render(<LocalAgentsSettingsSection />)
      const status = screen.getByText('Downloading Claude Code 2.1.276 — 107 of 215 MB.')
      expect(status.parentElement!.className).toContain('min-h-[1lh]')
      expect((screen.getByRole('button', { name: 'Installing…' }) as HTMLButtonElement).disabled).toBe(true)
    })

    it('a failed Claude Path reads Unavailable on the button — never "<pin> managed" above a red line about the user’s own file', () => {
      appSettings = { ...appSettings, localAgentsClaudePath: '/opt/claude' }
      claudeBinary = { state: 'failed', error: 'Claude path will not run — fix it in Local Development.' }
      render(<LocalAgentsSettingsSection />)
      const status = screen.getByText('Claude path will not run — fix it in Local Development.')
      expect(status.className).toContain('text-[var(--color-danger)]')
      expect(screen.getByRole('button', { name: /^Claude Agent/ }).textContent).toBe('Claude AgentUnavailable')
      // Not *Try again*: it would re-check the same bad path. The field is on
      // another tab, so the action goes there.
      expect(screen.queryByRole('button', { name: /Try again|Install now/ })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Fix path' }))
      expect(useUIStore.getState().settingsTab).toBe('local-dev')
      expect(resolveClaude.mutate).not.toHaveBeenCalled()
      // Closes nothing: another runtime is still one click away (rule 6).
      expect(screen.getByRole('button', { name: /Custom OpenCode/ })).toBeTruthy()
    })

    it('does not offer Install now beside a saved path that simply has not been checked yet', () => {
      appSettings = { ...appSettings, localAgentsClaudePath: '/opt/claude' }
      claudeBinary = { state: 'unresolved' }
      render(<LocalAgentsSettingsSection />)
      expect(screen.getByText('Your configured Claude path is checked on first use.')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Install now' })).toBeNull()
      expect(screen.getByRole('button', { name: /^Claude Agent/ }).textContent).toBe('Claude Agentunverified')
    })

    it('says nothing while the state is still being read', () => {
      claudeBinary = undefined
      render(<LocalAgentsSettingsSection />)
      expect(screen.queryByText(/Claude Code 2\.1\.276/)).toBeNull()
    })
  })

  it('the Codex button too reads Unavailable when a saved Codex Path failed', () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex', localAgentsCodexPath: '/opt/codex' }
    codexBinary = { state: 'failed', error: 'Codex path will not run — fix it in Local Development.' }
    render(<LocalAgentsSettingsSection />)
    expect(screen.getByRole('button', { name: /^Codex/ }).textContent).toBe('CodexUnavailable')
    expect(screen.queryByRole('button', { name: /Try again|Install now/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fix path' }))
    expect(useUIStore.getState().settingsTab).toBe('local-dev')
  })

  it('the Codex row agrees with the Claude row: no Install now beside a saved, unchecked path', () => {
    // Mutation: drop `pathSet` from ManagedCliAction and "Install now" sits
    // beside "Your configured Codex path is checked on first use."
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex', localAgentsCodexPath: '/opt/codex' }
    codexBinary = { state: 'unresolved' }
    render(<LocalAgentsSettingsSection />)
    expect(screen.getByText('Your configured Codex path is checked on first use.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install now' })).toBeNull()
  })

  it('a failed managed install still offers Try again', () => {
    appSettings = { ...HEALTHY_SETTINGS, localAgentsDefaultEngine: 'codex' }
    codexBinary = { state: 'failed', error: 'offline' }
    render(<LocalAgentsSettingsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(resolveCodex.mutate).toHaveBeenCalledTimes(1)
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
})
