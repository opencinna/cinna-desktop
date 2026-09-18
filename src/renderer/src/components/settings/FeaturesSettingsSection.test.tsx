import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const HEALTHY = {
  autoChatTitles: true,
  enableTrayIcon: false,
  showHints: false,
  prioritizeAccountDefaults: false
}
let settings: Record<string, boolean | string> | undefined = HEALTHY
let isError = false
let saveError: Error | null = null
const setSetting = vi.fn()
beforeEach(() => {
  settings = HEALTHY
  isError = false
  saveError = null
  setSetting.mockReset()
})
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }))
vi.mock('../../hooks/useAppSettings', () => ({
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
  render(<FeaturesSettingsSection />)
  expect(screen.getByText('Runs on: Default runtime — the chosen credential is missing')).toBeTruthy()
  // The picker keeps marking the stale choice.
  expect(screen.getByRole('option', { name: 'Missing credential' })).toBeTruthy()
})
