import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiFunctionsBackendStatus } from '../../../../shared/aiFunctions'

const HEALTHY = {
  autoChatTitles: true,
  enableTrayIcon: false,
  showHints: false,
  prioritizeAccountDefaults: false
}
let settings: Record<string, boolean | string> | undefined = HEALTHY
let isError = false
let saveError: Error | null = null
let functionsBackend: AiFunctionsBackendStatus | undefined = { runsOn: 'runtime', reason: 'unset' }
let providers: unknown[] = []
let models: unknown[] = []
const setSetting = vi.fn()
beforeEach(() => {
  functionsBackend = { runsOn: 'runtime', reason: 'unset' }
  providers = []
  models = []
  settings = HEALTHY
  isError = false
  saveError = null
  setSetting.mockReset()
})
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: providers }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: models }) }))
vi.mock('../../hooks/useAppSettings', () => ({
  useAiFunctionsBackend: () => ({ data: functionsBackend }),
  useAppSettings: () => ({ data: settings, isLoading: false, isError }),
  useSetAppSetting: () => ({ mutate: setSetting, isPending: false, error: saveError })
}))

const { FeaturesSettingsSection } = await import('./FeaturesSettingsSection')
const { useUIStore } = await import('../../stores/ui.store')

/**
 * Two titled sections, each one `SettingsRows` list of one-line toggles. The
 * description of each toggle is behind its `(?)`, not a paragraph under the
 * label (ux_rules rule 12).
 */
describe('FeaturesSettingsSection', () => {
  it('is two titled sections of one-line rows, with the descriptions behind the tips', () => {
    render(<FeaturesSettingsSection />)

    expect(screen.getByRole('heading', { name: 'AI Functions' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Interface' })).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(6)
    // The label names the switch (rule 10), not the branching title.
    expect(screen.getByRole('switch', { name: 'Auto-generate chat titles' })).toBeTruthy()
    expect(screen.queryByText(/Couldn’t load settings/)).toBeNull()
    // No standing prose on the surface.
    expect(screen.queryByText(/Generates a short title/)).toBeNull()
    expect(screen.queryByText(/Show the menu-bar icon/)).toBeNull()
    // No Reset hints row while hints are off.
    expect(screen.queryByRole('button', { name: 'Reset hints' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'About Auto-generate chat titles' }))
    expect(screen.getByText(/Generates a short title from your first message/)).toBeTruthy()
  })

  it('keeps the title attribute on the switch and toggles the setting', () => {
    render(<FeaturesSettingsSection />)

    const sections = screen.getByRole('switch', { name: 'Show sections in Agents sidebar' })
    expect(sections.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sections)
    expect(setSetting).toHaveBeenCalledWith({ key: 'showAgentSidebarSections', value: false })

    const tray = screen.getByRole('switch', { name: 'Enable Tray Icon' })
    expect(tray.getAttribute('title')).toBe('Menu-bar tray icon is hidden')
    fireEvent.click(tray)
    expect(setSetting).toHaveBeenCalledWith({ key: 'enableTrayIcon', value: true })
  })

  it('saves appearance changes immediately, including while service settings are unavailable', () => {
    settings = undefined
    useUIStore.setState({ extraUIAnimation: true, themePreference: 'dark', theme: 'dark' })
    render(<FeaturesSettingsSection />)
    const animation = screen.getByRole('switch', { name: 'Extra UI animation' })
    expect(animation.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(animation)
    expect(animation.getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem('cinna-extra-ui-animation')).toBe('0')
    fireEvent.click(screen.getByRole('button', { name: 'System' }))
    expect(useUIStore.getState().themePreference).toBe('system')
    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('cinna-theme')).toBe('light')
  })

  it('explains a rejected setting instead of silently resetting the switch', () => {
    saveError = new Error("Error invoking remote method 'settings:set': Error: Unknown app setting: showAgentSidebarSections")
    render(<FeaturesSettingsSection />)
    expect(screen.getByRole('alert').textContent).toContain('Restart Cinna Desktop')
  })

  it('shows other save errors with their actionable reason', () => {
    saveError = new Error('Could not write settings database')
    render(<FeaturesSettingsSection />)
    expect(screen.getByRole('alert').textContent).toContain('Could not write settings database')
  })

  it('adds the Reset hints row under Show hints while hints are on', () => {
    settings = { ...settings, showHints: true }
    render(<FeaturesSettingsSection />)

    expect(screen.getByText('No hints retired yet.')).toBeTruthy()
    const reset = screen.getByRole('button', { name: 'Reset hints' })
    expect((reset as HTMLButtonElement).disabled).toBe(true)
  })

  it('says the read failed once, last, and only when it did', () => {
    isError = true
    render(<FeaturesSettingsSection />)

    const errors = screen.getAllByText(/Couldn’t load settings/)
    expect(errors).toHaveLength(1)
    // Last in its list: nothing under it to move.
    expect(errors[0].nextElementSibling).toBeNull()
  })
})

it('saves the default routing independently from existing chats', () => {
  render(<FeaturesSettingsSection />)
  expect(screen.getByRole('button', { name: 'You route' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'AI routes' }))
  expect(setSetting).toHaveBeenCalledWith({ key: 'defaultMultiAgentRouting', value: 'coordinator' })
})

it('says a missing AI Functions credential runs on the Default runtime', () => {
  settings = { ...HEALTHY, aiFunctionsCredentialId: 'deleted-credential', aiFunctionsModelId: '' }
  functionsBackend = { runsOn: 'runtime', reason: 'missing' }
  render(<FeaturesSettingsSection />)
  expect(screen.getByText('Runs on: Default runtime — the chosen credential is missing')).toBeTruthy()
  // The picker keeps marking the stale choice.
  expect(screen.getByRole('option', { name: 'Missing credential' })).toBeTruthy()
})

/**
 * The "Runs on" line is main's answer (`settings:ai-functions-backend`), not a
 * renderer-side reading of the binding: it used to say a credential while main
 * was falling back to the Default runtime.
 */
describe('AI Functions "Runs on" line', () => {
  const SONNET = { id: 'cred', type: 'anthropic', name: 'Sonnet', enabled: true, hasApiKey: true }

  it.each([
    [{ runsOn: 'runtime', reason: 'unset' }, 'Runs on: Default runtime'],
    [{ runsOn: 'runtime', reason: 'missing' }, 'Runs on: Default runtime — the chosen credential is missing'],
    [{ runsOn: 'runtime', reason: 'inactive' }, 'Runs on: Default runtime — the chosen credential is inactive'],
    [{ runsOn: 'runtime', reason: 'no_model' }, 'Runs on: Default runtime — the chosen credential has no model'],
    [{ runsOn: 'credential', credentialId: 'cred', credentialName: 'Sonnet', modelId: 'claude-x' }, 'Runs on: Sonnet · claude-x']
  ] as [AiFunctionsBackendStatus, string][])('renders %o as "%s"', (status, text) => {
    functionsBackend = status
    render(<FeaturesSettingsSection />)
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('names main\'s model from the loaded model list of that credential only', () => {
    functionsBackend = { runsOn: 'credential', credentialId: 'cred', credentialName: 'Sonnet', modelId: 'claude-x' }
    models = [{ id: 'claude-x', name: 'Other credential’s name', providerId: 'other' }]
    const { unmount } = render(<FeaturesSettingsSection />)
    expect(screen.getByText('Runs on: Sonnet · claude-x')).toBeTruthy()
    unmount()
    models = [...models, { id: 'claude-x', name: 'Claude X', providerId: 'cred' }]
    render(<FeaturesSettingsSection />)
    expect(screen.getByText('Runs on: Sonnet · Claude X')).toBeTruthy()
  })

  it('follows main when an active credential has no model, even though the renderer sees it active', () => {
    settings = { ...HEALTHY, aiFunctionsCredentialId: 'cred', aiFunctionsModelId: '' }
    providers = [SONNET]
    functionsBackend = { runsOn: 'runtime', reason: 'no_model' }
    render(<FeaturesSettingsSection />)
    expect(screen.getByText('Runs on: Default runtime — the chosen credential has no model')).toBeTruthy()
    expect(screen.queryByText(/Sonnet · /)).toBeNull()
  })

  it('names the stored model main uses even when it is not in the credential list, and keeps the picker entry', () => {
    settings = { ...HEALTHY, aiFunctionsCredentialId: 'cred', aiFunctionsModelId: 'retired-model' }
    providers = [SONNET]
    functionsBackend = { runsOn: 'credential', credentialId: 'cred', credentialName: 'Sonnet', modelId: 'retired-model' }
    render(<FeaturesSettingsSection />)
    expect(screen.getByText('Runs on: Sonnet · retired-model')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Choose a model for this credential' })).toBeTruthy()
  })

  it('keeps the line, with a neutral placeholder, while the status loads', () => {
    functionsBackend = undefined
    render(<FeaturesSettingsSection />)
    const line = screen.getByText('Runs on: —')
    expect(line.getAttribute('aria-busy')).toBe('true')
  })
})
