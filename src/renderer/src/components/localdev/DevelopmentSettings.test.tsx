import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsSchema } from '../../../../shared/appSettings'
import { useUIStore } from '../../stores/ui.store'

vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
const binaries = vi.hoisted(() => ({ codex: { state: 'unresolved' } as Record<string, unknown>, claude: { state: 'unresolved' } as Record<string, unknown>, antigravity: { state: 'unresolved' } as Record<string, unknown> }))
const auth = vi.hoisted(() => ({ codex: { state: 'logged_in' } as Record<string, unknown> }))
vi.mock('../../hooks/useEngine', () => ({ DEFAULT_RUNTIME_KEY: ['default-runtime'], useDefaultRuntime: () => ({ data: { engine: 'claude' } }), useCodexBinary: () => ({ data: binaries.codex }), useClaudeBinary: () => ({ data: binaries.claude }), useAntigravityBinary: () => ({ data: binaries.antigravity }) }))
vi.mock('../../hooks/useLocalTools', () => ({
  CLAUDE_AUTH_KEY: ['claude-auth'],
  CODEX_AUTH_KEY: ['codex-auth'],
  ANTIGRAVITY_AUTH_KEY: ['antigravity-auth'],
  ENGINE_LOGIN_RUNNING_KEY: ['engine-login-running'],
  useClaudeAuth: () => ({ data: { state: 'logged_in' } }),
  useCodexAuth: ({ enabled }: { enabled: boolean }) => ({ data: enabled ? auth.codex : undefined }),
  useAntigravityAuth: () => ({ data: { state: 'logged_in' } }),
  useEngineLoginRunning: () => ({ data: { claude: null, codex: null, antigravity: null } }),
  useLocalTools: () => ({ data: [{ id: 'claude', available: true }, { id: 'codex', available: true }] }),
  useToolInstallPlan: () => null,
  useInstallRuntimeTool: () => ({ isPending: false })
}))
const { DevelopmentSettings } = await import('./DevelopmentSettings')
let settings: Partial<AppSettingsSchema>
let set: ReturnType<typeof vi.fn>
let runtimeSetup: ReturnType<typeof vi.fn>
let providers: Array<Record<string, unknown>>
/** Past the chip's double-click guard, which also counts the selection arriving with the settings. */
const chipSettles = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 450))
function show() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DevelopmentSettings onSetup={() => {}} onCheck={() => {}} onOpenWorkspace={() => {}} /></QueryClientProvider>)
}
beforeEach(() => {
  settings = { localAgentsDefaultEngine: 'claude', localDevelopmentEngine: '', localDevelopmentCredentialId: '', localDevelopmentComplexity: 'complex' }
  set = vi.fn(async (key: string, value: string) => { settings = { ...settings, [key]: value }; return { success: true } })
  runtimeSetup = vi.fn(async () => ({ outcome: 'ready' }))
  providers = [{ id: 'build-key', name: 'Build API', enabled: true, type: 'openai', hasApiKey: true }]
  binaries.codex = { state: 'unresolved' }
  binaries.claude = { state: 'unresolved' }
  binaries.antigravity = { state: 'unresolved' }
  auth.codex = { state: 'logged_in' }
  useUIStore.setState({ settingsTab: 'local-dev', activeView: 'chat' } as never)
  Object.assign(window, { api: {
    app: { setTheme: async () => {} },
    localTools: { runtimeSetup, runtimeSetupCancel: vi.fn(async () => true), runtimeSetupRunning: async () => ({ claude: null, codex: null, antigravity: null }) },
    logger: { log: async () => {} },
    settings: { getAll: async () => settings, set },
    providers: { list: async () => providers, onAccountConfigSynced: () => () => {} }
  } })
})
describe('Local Development runtime settings', () => {
  it('defaults to Complex and persists work complexity independently of runtime choice', async () => {
    show()
    const choice = await screen.findByLabelText('Work complexity') as HTMLSelectElement
    await waitFor(() => expect(choice.disabled).toBe(false))
    expect(choice.value).toBe('complex')
    fireEvent.click(screen.getByRole('button', { name: 'About Work complexity' }))
    expect(screen.getByText(/Claude uses Opus/)).toBeTruthy()
    fireEvent.change(choice, { target: { value: 'medium' } })
    await waitFor(() => expect(set).toHaveBeenCalledWith('localDevelopmentComplexity', 'medium'))
    expect(settings.localDevelopmentEngine).toBe('')
    expect(settings.localAgentsDefaultEngine).toBe('claude')
  })
  it('defaults to inheritance and saves overrides without changing the local-agent runtime', async () => {
    show()
    const inherited = await screen.findByRole('button', { name: /Default Runtime/ })
    await waitFor(() => expect((inherited as HTMLButtonElement).disabled).toBe(false))
    expect(inherited.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /^Codex/ }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('localDevelopmentEngine', 'codex'))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Codex/ }).getAttribute('aria-pressed')).toBe('true'))
    expect(settings.localAgentsDefaultEngine).toBe('claude')
    fireEvent.click(inherited)
    await waitFor(() => expect(settings.localDevelopmentEngine).toBe(''))
  })
  it('retains the previous selection and shows a save failure', async () => {
    set.mockRejectedValue(new Error('Disk is full'))
    show()
    const choice = screen.getByRole('button', { name: /^Codex/ })
    await waitFor(() => expect((choice as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(choice)
    expect(await screen.findByRole('alert')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: /Default Runtime/ }).getAttribute('aria-pressed')).toBe('true'))
    expect(settings.localDevelopmentEngine).toBe('')
  })
  it('stores the OpenCode building credential separately', async () => {
    settings.localDevelopmentEngine = 'opencode'
    show()
    const select = await screen.findByLabelText('AI credential')
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false))
    fireEvent.change(select, { target: { value: 'build-key' } })
    await waitFor(() => expect(set).toHaveBeenCalledWith('localDevelopmentCredentialId', 'build-key'))
    expect(settings.localAgentsDefaultEngine).toBe('claude')
  })
  it('selecting a runtime that is not on disk downloads nothing; the selected card offers Install, which installs through main', async () => {
    show()
    const codex = await screen.findByRole('button', { name: /^Codex/ })
    await waitFor(() => expect((codex as HTMLButtonElement).disabled).toBe(false))
    expect(codex.textContent).toContain('Not installed')
    fireEvent.click(codex)
    await waitFor(() => expect(set).toHaveBeenCalledWith('localDevelopmentEngine', 'codex'))
    const install = await screen.findByRole('button', { name: 'Install' })
    expect(runtimeSetup).not.toHaveBeenCalled()
    // A chip ignores presses for a moment after its card is selected (a double-click guard).
    await chipSettles()
    fireEvent.click(install)
    await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('codex', { install: true, login: 'auto' }))
  })
  it('selecting an installed runtime checks its sign-in through main, and a logged-out one shows Log in', async () => {
    binaries.codex = { state: 'ready', path: '/c', source: 'managed', version: 'codex-cli 1' }
    show()
    const codex = await screen.findByRole('button', { name: /^Codex/ })
    await waitFor(() => expect((codex as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(codex)
    await waitFor(() => expect(runtimeSetup).toHaveBeenCalledWith('codex', { install: false, login: 'auto' }))
    expect(runtimeSetup).not.toHaveBeenCalledWith('codex', { install: true, login: 'auto' })
  })
  it('a visit to a logged-out runtime shows Log in and starts nothing', async () => {
    settings.localDevelopmentEngine = 'codex'
    binaries.codex = { state: 'ready', path: '/c', source: 'managed', version: 'codex-cli 1' }
    auth.codex = { state: 'logged_out' }
    show()
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy()
    expect(screen.getByText('Codex is not logged in.')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runtimeSetup).not.toHaveBeenCalled()
  })
  it('Custom OpenCode with no credential: Add credential opens Settings → AI Credentials', async () => {
    settings.localDevelopmentEngine = 'opencode'
    providers = []
    show()
    const add = await screen.findByRole('button', { name: 'Add credential' })
    await chipSettles()
    fireEvent.click(add)
    expect(useUIStore.getState().settingsTab).toBe('llm')
    expect(useUIStore.getState().activeView).toBe('settings')
  })
  it('says the download in the line while it runs, muted like the Agents tab, not what the choice means', async () => {
    settings.localDevelopmentEngine = 'codex'
    binaries.codex = { state: 'resolving', received: 45 * 1024 * 1024, total: 90 * 1024 * 1024 }
    show()
    const line = await screen.findByText(/^Downloading Codex \S+ — 45 of 90 MB\.$/)
    expect(line.className).toContain('text-[var(--color-text-muted)]')
    expect(screen.queryByText('Used for local build sessions on this computer.')).toBeNull()
  })
  it('keeps the Antigravity terms behind a (?) at the line end while a status holds the line', async () => {
    settings.localDevelopmentEngine = 'antigravity'
    binaries.antigravity = { state: 'failed', error: 'Antigravity could not be downloaded.' }
    show()
    const line = await screen.findByText('Antigravity could not be downloaded.')
    expect(line.parentElement!.contains(screen.getByRole('button', { name: 'About Antigravity’s terms' }))).toBe(true)
  })
})
