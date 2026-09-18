import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsSchema } from '../../../../shared/appSettings'

vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
vi.mock('../../hooks/useEngine', () => ({ DEFAULT_RUNTIME_KEY: ['default-runtime'], useDefaultRuntime: () => ({ data: { engine: 'claude' } }), useCodexBinary: () => ({ data: { state: 'unresolved' } }) }))
vi.mock('../../hooks/useLocalTools', () => ({
  useLocalTools: () => ({ data: [{ id: 'claude', available: true }, { id: 'codex', available: true }] }),
  useToolInstallPlan: () => null,
  useInstallRuntimeTool: () => ({ isPending: false })
}))
const { DevelopmentSettings } = await import('./DevelopmentSettings')
let settings: Partial<AppSettingsSchema>
let set: ReturnType<typeof vi.fn>
function show() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DevelopmentSettings onSetup={() => {}} onCheck={() => {}} onOpenWorkspace={() => {}} /></QueryClientProvider>)
}
beforeEach(() => {
  settings = { localAgentsDefaultEngine: 'claude', localDevelopmentEngine: '', localDevelopmentCredentialId: '', localDevelopmentComplexity: 'complex' }
  set = vi.fn(async (key: string, value: string) => { settings = { ...settings, [key]: value }; return { success: true } })
  Object.assign(window, { api: {
    app: { setTheme: async () => {} },
    logger: { log: async () => {} },
    settings: { getAll: async () => settings, set },
    providers: { list: async () => [{ id: 'build-key', name: 'Build API', enabled: true }], onAccountConfigSynced: () => () => {} }
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
})
