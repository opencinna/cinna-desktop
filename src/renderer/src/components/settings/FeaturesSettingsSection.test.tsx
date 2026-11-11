import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiFunctionsBackendStatus } from '../../../../shared/aiFunctions'
import type { SpeechStatus } from '../../../../shared/speech'

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
let serviceSaveFails = false
beforeEach(() => {
  functionsBackend = { runsOn: 'runtime', reason: 'unset' }
  providers = []
  models = []
  settings = HEALTHY
  speech = NO_SPEECH
  isError = false
  saveError = null
  setSetting.mockReset()
  serviceSaveFails = false
})
vi.mock('../../hooks/useProviders', () => ({ useProviders: () => ({ data: providers }) }))
vi.mock('../../hooks/useModels', () => ({ useModels: () => ({ data: models }) }))
// Its own section with its own test (FinderQuickActionSection.test.tsx).
vi.mock('./FinderQuickActionSection', () => ({ FinderQuickActionSection: () => null }))
const NO_SPEECH: SpeechStatus = { supported: false, engine: null, authorization: 'unknown', available: false, cloud: { mode: 'off', setting: '', service: 'core', usable: false, providers: [], relay: { available: false } } }
let speech: SpeechStatus = NO_SPEECH
vi.mock('../chat/voice/useSpeechStatus', () => ({ useSpeechStatus: () => speech }))
vi.mock('../../hooks/useAppSettings', () => ({
  useAiFunctionsBackend: () => ({ data: functionsBackend }),
  useAppSettings: () => ({ data: settings, isLoading: false, isError }),
  useSetAppSetting: () => ({
    mutate: setSetting,
    // The service save before a mode: recorded like mutate, failing when asked to.
    mutateAsync: (input: unknown) => {
      setSetting(input)
      return serviceSaveFails ? Promise.reject(new Error('save failed')) : Promise.resolve()
    },
    isPending: false,
    error: saveError
  })
}))

const { FeaturesSettingsSection, VOICE_INPUT_UNAVAILABLE, VOICE_INPUT_NO_CLOUD_SERVICE } = await import('./FeaturesSettingsSection')
const { useUIStore } = await import('../../stores/ui.store')

/**
 * Three titled sections, each one `SettingsRows` list of one-line toggles. The
 * description of each toggle is behind its `(?)`, not a paragraph under the
 * label (ux_rules rule 12).
 */
describe('FeaturesSettingsSection', () => {
  it('is three titled sections of one-line rows, with the descriptions behind the tips', () => {
    render(<FeaturesSettingsSection />)

    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Capabilities', 'AI Functions', 'Interface'])
    // Audio input counts even with no speech engine: it is always rendered, disabled.
    expect(screen.getAllByRole('switch')).toHaveLength(14)
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

  it('turns the Notes and Dashboards capabilities on and off through main’s app settings', () => {
    // `'unset'` is main's not-decided-yet, and reads as off: no tab until it is on.
    settings = { ...HEALTHY, notesCapability: 'off', dashboardsCapability: 'unset' }
    const { rerender } = render(<FeaturesSettingsSection />)
    const notes = screen.getByRole('switch', { name: 'Notes' })
    const dashboards = screen.getByRole('switch', { name: 'Dashboards' })
    expect(notes.getAttribute('aria-checked')).toBe('false')
    expect(dashboards.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(notes)
    expect(setSetting).toHaveBeenLastCalledWith({ key: 'notesCapability', value: 'on' })
    fireEvent.click(dashboards)
    expect(setSetting).toHaveBeenLastCalledWith({ key: 'dashboardsCapability', value: 'on' })

    settings = { ...HEALTHY, notesCapability: 'on', dashboardsCapability: 'on' }
    rerender(<FeaturesSettingsSection />)
    expect(screen.getByRole('switch', { name: 'Notes' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: 'Dashboards' }))
    expect(setSetting).toHaveBeenLastCalledWith({ key: 'dashboardsCapability', value: 'off' })
    // Nothing of it is kept in the renderer.
    expect(localStorage.getItem('cinna-notes-enabled')).toBeNull()
  })

  it('has a Tasks button switch, on by default, kept in the UI store like the other appearance rows', () => {
    useUIStore.setState({ showTasksButton: true })
    render(<FeaturesSettingsSection />)
    const tasks = screen.getByRole('switch', { name: 'Tasks button' })
    expect(tasks.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(tasks)
    expect(useUIStore.getState().showTasksButton).toBe(false)
    expect(tasks.getAttribute('aria-checked')).toBe('false')
    expect(setSetting).not.toHaveBeenCalled()
    fireEvent.click(tasks)
    expect(useUIStore.getState().showTasksButton).toBe(true)
  })

  it('guides the first build of new agents unless it was turned off, and says the consequence behind its tip', () => {
    render(<FeaturesSettingsSection />)
    const guided = screen.getByRole('switch', { name: 'Guide the first build of new agents' })
    // An AI function, right after Auto-generate chat titles (rule 12).
    const section = screen.getByRole('heading', { name: 'AI Functions' }).closest('section')!
    const switches = within(section).getAllByRole('switch')
    const titles = within(section).getByRole('switch', { name: 'Auto-generate chat titles' })
    expect(switches.indexOf(guided)).toBe(switches.indexOf(titles) + 1)
    // Absent from the store means the default, which is on.
    expect(guided.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(guided)
    expect(setSetting).toHaveBeenCalledWith({ key: 'guidedFirstBuild', value: false })
    fireEvent.click(screen.getByRole('button', { name: 'About Guide the first build of new agents' }))
    expect(screen.getByText(/Off: its first chat starts like any other/)).toBeTruthy()
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

  it('has Desktop notifications on unless it was turned off, right after the tray icon row', () => {
    const { unmount } = render(<FeaturesSettingsSection />)

    const notifications = screen.getByRole('switch', { name: 'Desktop notifications' })
    const switches = screen.getAllByRole('switch')
    expect(switches.indexOf(notifications)).toBe(switches.indexOf(screen.getByRole('switch', { name: 'Enable Tray Icon' })) + 1)
    // Absent from the store means the default, which is on.
    expect(notifications.getAttribute('aria-checked')).toBe('true')
    expect(notifications.getAttribute('title')).toBe('Desktop notifications are on')
    expect(screen.queryByText(/while Cinna is in the background/)).toBeNull()
    fireEvent.click(notifications)
    expect(setSetting).toHaveBeenCalledWith({ key: 'desktopNotifications', value: false })
    fireEvent.click(screen.getByRole('button', { name: 'About Desktop notifications' }))
    expect(screen.getByText(/needs your input, or fails while Cinna is in the background/)).toBeTruthy()
    unmount()

    settings = { ...HEALTHY, desktopNotifications: false }
    render(<FeaturesSettingsSection />)
    const off = screen.getByRole('switch', { name: 'Desktop notifications' })
    expect(off.getAttribute('aria-checked')).toBe('false')
    expect(off.getAttribute('title')).toBe('Desktop notifications are off')
    fireEvent.click(off)
    expect(setSetting).toHaveBeenCalledWith({ key: 'desktopNotifications', value: true })
  })

  it('shows local agents and chats in all profiles unless it was turned off, right after the sidebar-sections row', () => {
    const { unmount } = render(<FeaturesSettingsSection />)

    const shared = screen.getByRole('switch', { name: 'Show local agents and chats in all profiles' })
    const switches = screen.getAllByRole('switch')
    expect(switches.indexOf(shared)).toBe(switches.indexOf(screen.getByRole('switch', { name: 'Show sections in Agents sidebar' })) + 1)
    // Absent from the store means the default, which is on.
    expect(shared.getAttribute('aria-checked')).toBe('true')
    expect(shared.getAttribute('title')).toBe('Local chats appear in every profile')
    fireEvent.click(shared)
    expect(setSetting).toHaveBeenCalledWith({ key: 'showLocalDataInAllProfiles', value: false })
    // Both modes are explained behind the tip, not under the label.
    expect(screen.queryByText(/belong to this computer/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Show local agents and chats in all profiles' }))
    expect(screen.getByText(/Off: each chat stays in the profile it was started in/)).toBeTruthy()
    unmount()

    settings = { ...HEALTHY, showLocalDataInAllProfiles: false }
    render(<FeaturesSettingsSection />)
    const off = screen.getByRole('switch', { name: 'Show local agents and chats in all profiles' })
    expect(off.getAttribute('aria-checked')).toBe('false')
    expect(off.getAttribute('title')).toBe('Chats stay in the profile they were started in')
    fireEvent.click(off)
    expect(setSetting).toHaveBeenCalledWith({ key: 'showLocalDataInAllProfiles', value: true })
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

  it('keeps table headers sticky by default, and saves turning it off at once', () => {
    localStorage.removeItem('cinna-sticky-table-headers')
    useUIStore.setState({ stickyTableHeaders: true })
    render(<FeaturesSettingsSection />)
    const sticky = screen.getByRole('switch', { name: 'Sticky table headers' })
    expect(sticky.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sticky)
    expect(sticky.getAttribute('aria-checked')).toBe('false')
    expect(useUIStore.getState().stickyTableHeaders).toBe(false)
    expect(localStorage.getItem('cinna-sticky-table-headers')).toBe('0')
    expect(sticky.getAttribute('title')).toBe('Table headers scroll away with the table')
  })

  it('sets the sidebar docking right after Theme, with its explanation behind the tip', () => {
    useUIStore.setState({ sidebarDocking: 'fixed', sidebarOpen: true, sidebarPeek: false })
    render(<FeaturesSettingsSection />)
    const group = screen.getByRole('group', { name: 'Sidebar docking' })
    const theme = screen.getByRole('button', { name: 'System' }).closest('[role="group"]') as HTMLElement
    expect(theme.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(/pointer reaches the left edge/)).toBeNull()

    const fixed = screen.getByRole('button', { name: 'Fixed' })
    const hover = screen.getByRole('button', { name: 'On Hover' })
    expect(fixed.getAttribute('aria-pressed')).toBe('true')
    expect(hover.className).toContain('text-[13px]')
    fireEvent.click(hover)
    expect(useUIStore.getState().sidebarDocking).toBe('hover')
    expect(localStorage.getItem('cinna-sidebar-docking')).toBe('hover')
    expect(hover.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(fixed)
    expect(useUIStore.getState().sidebarDocking).toBe('fixed')

    fireEvent.click(screen.getByRole('button', { name: 'About Sidebar docking' }))
    expect(screen.getByText(/pointer reaches the left edge of the window/)).toBeTruthy()
  })

  it('sets Branding right under Theme, Account Branded by default, and saves only a change', () => {
    render(<FeaturesSettingsSection />)
    const group = screen.getByRole('group', { name: 'Branding' })
    const theme = screen.getByRole('button', { name: 'System' }).closest('[role="group"]') as HTMLElement
    const docking = screen.getByRole('group', { name: 'Sidebar docking' })
    expect(theme.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(group.compareDocumentPosition(docking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const original = within(group).getByRole('button', { name: 'Cinna Original' })
    const branded = within(group).getByRole('button', { name: 'Account Branded' })
    expect(branded.getAttribute('aria-pressed')).toBe('true')
    expect(original.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(branded)
    expect(setSetting).not.toHaveBeenCalled()
    fireEvent.click(original)
    expect(setSetting).toHaveBeenCalledWith({ key: 'serverBranding', value: false })
  })

  it('shows Cinna Original as chosen when branding is off, and nothing chosen before settings load', () => {
    settings = { ...HEALTHY, serverBranding: false }
    const { unmount } = render(<FeaturesSettingsSection />)
    const group = screen.getByRole('group', { name: 'Branding' })
    expect(within(group).getByRole('button', { name: 'Cinna Original' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(group).getByRole('button', { name: 'Account Branded' }))
    expect(setSetting).toHaveBeenCalledWith({ key: 'serverBranding', value: true })
    unmount()

    settings = undefined
    render(<FeaturesSettingsSection />)
    const loading = screen.getByRole('group', { name: 'Branding' })
    for (const button of within(loading).getAllByRole('button')) {
      expect(button.getAttribute('aria-pressed')).toBe('false')
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
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

it('shows Mid as the default AI spending level and saves another level', () => {
  render(<FeaturesSettingsSection />)
  const group = screen.getByRole('group', { name: 'AI spending level' })
  const pressed = Array.from(group.querySelectorAll('button')).filter((b) => b.getAttribute('aria-pressed') === 'true')
  expect(pressed.map((b) => b.textContent)).toEqual(['Mid'])
  fireEvent.click(screen.getByRole('button', { name: 'Eco' }))
  expect(setSetting).toHaveBeenCalledWith({ key: 'aiSpendingLevel', value: 'eco' })
})

it('marks the saved AI spending level', () => {
  settings = { ...HEALTHY, aiSpendingLevel: 'greedy' }
  render(<FeaturesSettingsSection />)
  expect(screen.getByRole('button', { name: 'Greedy' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Mid' }).getAttribute('aria-pressed')).toBe('false')
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

describe('voice input rows', () => {
  const G1 = { id: 'g1', name: 'Personal Gemini' }
  const G2 = { id: 'g2', name: 'Work Gemini' }
  const ON_DEVICE: SpeechStatus = { supported: true, engine: 'macos', authorization: 'granted', available: true, cloud: { mode: 'off', setting: '', service: 'core', usable: false, providers: [], relay: { available: false } } }
  const CLOUD_MODES = { off: 'Off', fallback: 'As a fallback', always: 'Always' } as const
  type CloudMode = keyof typeof CLOUD_MODES
  const cloudGroup = (): HTMLElement => screen.getByRole('group', { name: 'Cloud transcription' })
  const cloudPill = (mode: CloudMode): HTMLButtonElement => within(cloudGroup()).getByRole('button', { name: CLOUD_MODES[mode] }) as HTMLButtonElement
  /** The one pressed pill's mode; fails unless exactly one is pressed. */
  function cloudMode(): CloudMode {
    const pressed = (Object.keys(CLOUD_MODES) as CloudMode[]).filter((mode) => cloudPill(mode).getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    return pressed[0]
  }
  /** Whether the pills are disabled; fails unless all three agree. */
  function cloudDisabled(): boolean {
    const states = new Set((Object.keys(CLOUD_MODES) as CloudMode[]).map((mode) => cloudPill(mode).disabled))
    expect(states.size).toBe(1)
    return [...states][0]
  }
  const chooseCloud = (mode: CloudMode): void => { fireEvent.click(cloudPill(mode)) }
  const audioInput = (): HTMLElement => screen.getByRole('switch', { name: 'Audio input' })
  function voiceDescription(): string {
    fireEvent.click(screen.getByRole('button', { name: 'About Audio input' }))
    return screen.getByText(/Shows the microphone button/).textContent ?? ''
  }

  it('without an on-device engine or a Gemini credential (Linux): the modes stay open; with My Gemini key saved, a neutral requirement with a way to AI Credentials', () => {
    useUIStore.setState({ activeView: 'settings', settingsTab: 'features' } as never)
    const { rerender } = render(<FeaturesSettingsSection />)
    // Always rendered, so a cloud mode chosen below never inserts a row above the pills.
    expect(audioInput().getAttribute('aria-checked')).toBe('false')
    expect((audioInput() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTitle('No speech recognition on this computer: turn on Cloud transcription below')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'About Audio input' }))
    expect(screen.getByText(VOICE_INPUT_UNAVAILABLE)).toBeTruthy()
    expect(cloudMode()).toBe('off')
    // Never locked by what this computer or the signed-in server offers (rule 21).
    expect(cloudDisabled()).toBe(false)
    // Nothing saved: turning a mode on saves the Cinna server, so no Gemini requirement.
    expect(screen.queryByText('No Gemini credential')).toBeNull()
    settings = { ...HEALTHY, voiceCloudService: 'gemini' }
    rerender(<FeaturesSettingsSection />)
    expect(screen.getByText('No Gemini credential')).toBeTruthy()
    expect(document.querySelector('[class*="--color-warning"]')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Gemini provider' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open AI Credentials' }))
    expect(useUIStore.getState()).toMatchObject({ activeView: 'settings', settingsTab: 'llm' })
  })

  it('with a mode already on but no usable service, the disabled Audio input does not ask to turn Cloud transcription on', () => {
    settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'gemini' }
    render(<FeaturesSettingsSection />)
    expect((audioInput() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTitle('Cloud transcription below has no usable service yet')).toBeTruthy()
    expect(screen.queryByTitle(/turn on Cloud transcription/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Audio input' }))
    expect(screen.getByText(VOICE_INPUT_NO_CLOUD_SERVICE)).toBeTruthy()
  })

  it('on a Mac with on-device speech, Off and no Gemini credential: the requirement is behind the (?), not on the surface', () => {
    speech = ON_DEVICE
    render(<FeaturesSettingsSection />)
    expect(screen.queryByText('No Gemini credential')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Cloud transcription' }))
    expect(screen.getByText(/Needs a Gemini credential with an API key, added under AI Credentials/)).toBeTruthy()
  })

  it('puts Audio input above Cloud transcription, in both states, so a choice in the pills moves nothing above them', () => {
    speech = ON_DEVICE
    const { rerender } = render(<FeaturesSettingsSection />)
    expect(audioInput().compareDocumentPosition(cloudGroup()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    speech = NO_SPEECH
    rerender(<FeaturesSettingsSection />)
    expect(audioInput().compareDocumentPosition(cloudGroup()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows Cloud transcription as Off / As a fallback / Always pills, one pressed, and a click on the pressed one saves nothing', () => {
    settings = { ...HEALTHY, voiceCloudTranscription: 'fallback', voiceCloudService: 'gemini' }
    speech = { ...ON_DEVICE, cloud: { mode: 'fallback', setting: 'gemini', service: 'gemini', usable: true, providers: [G1], relay: { available: false } } }
    render(<FeaturesSettingsSection />)
    expect(within(cloudGroup()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Off', 'As a fallback', 'Always'])
    expect(cloudMode()).toBe('fallback')
    chooseCloud('fallback')
    expect(setSetting).not.toHaveBeenCalled()
    chooseCloud('always')
    expect(setSetting).toHaveBeenLastCalledWith({ key: 'voiceCloudTranscription', value: 'always' })
  })

  it('on a Mac with on-device speech, Audio input is an enabled switch that follows the setting', () => {
    speech = ON_DEVICE
    useUIStore.setState({ showVoiceInput: false } as never)
    render(<FeaturesSettingsSection />)
    expect((audioInput() as HTMLButtonElement).disabled).toBe(false)
    expect(audioInput().getAttribute('aria-checked')).toBe('false')
    fireEvent.click(audioInput())
    expect(useUIStore.getState().showVoiceInput).toBe(true)
    expect(audioInput().getAttribute('aria-checked')).toBe('true')
  })

  it('a mode already on stays changeable after its provider is gone, so it can be turned off', () => {
    settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'gemini' }
    speech = { ...ON_DEVICE, cloud: { mode: 'always', setting: 'gemini', service: 'gemini', usable: false, providers: [], relay: { available: false } } }
    render(<FeaturesSettingsSection />)
    expect(cloudDisabled()).toBe(false)
    // A mode that is on but cannot run is broken: the warning tone.
    expect(screen.getByText('No Gemini credential')).toBeTruthy()
    expect(document.querySelector('[class*="--color-warning"]')).toBeTruthy()
    chooseCloud('off')
    expect(setSetting).toHaveBeenLastCalledWith({ key: 'voiceCloudTranscription', value: 'off' })
  })

  it('with no on-device engine but a Gemini key (Linux, Windows): Audio input is enabled and promises Google, not this Mac', () => {
    settings = { ...HEALTHY, voiceCloudTranscription: 'fallback', voiceCloudService: 'gemini' }
    speech = { supported: false, engine: null, authorization: 'unknown', available: true, cloud: { mode: 'fallback', setting: 'gemini', service: 'gemini', usable: true, providers: [G1], relay: { available: false } } }
    render(<FeaturesSettingsSection />)
    expect((audioInput() as HTMLButtonElement).disabled).toBe(false)
    expect(cloudDisabled()).toBe(false)
    expect(cloudMode()).toBe('fallback')
    expect(screen.queryByText('No Gemini credential')).toBeNull()
    // One provider: nothing to pick.
    expect(screen.queryByRole('combobox', { name: 'Gemini provider' })).toBeNull()
    const description = voiceDescription()
    expect(description).toMatch(/sent to Google under your own Gemini provider key and billed to it/)
    expect(description).not.toMatch(/on this Mac/)
    chooseCloud('always')
    expect(setSetting).toHaveBeenLastCalledWith({ key: 'voiceCloudTranscription', value: 'always' })
  })

  it('on-device with cloud off promises this Mac only; on fallback it adds where the audio would go', () => {
    speech = ON_DEVICE
    const { unmount } = render(<FeaturesSettingsSection />)
    const off = voiceDescription()
    expect(off).toMatch(/on this Mac: Cinna sends the recording nowhere/)
    expect(off).not.toMatch(/Gemini/)
    unmount()
    settings = { ...HEALTHY, voiceCloudTranscription: 'fallback', voiceCloudService: 'gemini' }
    speech = { ...ON_DEVICE, cloud: { mode: 'fallback', setting: 'gemini', service: 'gemini', usable: true, providers: [G1], relay: { available: false } } }
    render(<FeaturesSettingsSection />)
    const fallback = voiceDescription()
    expect(fallback).toMatch(/on this Mac/)
    expect(fallback).toMatch(/goes to Google Gemini instead, under your own Gemini provider key and billed to it/)
  })

  it('offers a provider picker only with more than one usable Gemini provider, showing the one main bills', () => {
    settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'gemini', voiceCloudProviderId: 'gone' }
    speech = { ...ON_DEVICE, cloud: { mode: 'always', setting: 'gemini', service: 'gemini', usable: true, providers: [G1, G2], relay: { available: false } } }
    const { rerender } = render(<FeaturesSettingsSection />)
    const picker = screen.getByRole('combobox', { name: 'Gemini provider' }) as HTMLSelectElement
    // A chosen id that is not usable falls to the first, as in main.
    expect(picker.value).toBe('g1')
    // A long name is truncated in the box; the title shows it whole.
    expect(picker.title).toBe('Personal Gemini')
    fireEvent.change(picker, { target: { value: 'g2' } })
    expect(setSetting).toHaveBeenLastCalledWith({ key: 'voiceCloudProviderId', value: 'g2' })
    settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'gemini', voiceCloudProviderId: 'g2' }
    rerender(<FeaturesSettingsSection />)
    expect((screen.getByRole('combobox', { name: 'Gemini provider' }) as HTMLSelectElement).value).toBe('g2')
    expect(voiceDescription()).toMatch(/Google Gemini/)
  })

  describe('the Service setting, the same on every profile (ux_rules rule 21)', () => {
    const RELAY = { available: true, serverName: 'Acme' }
    const NO_RELAY = { available: false }
    const serviceSelect = (): HTMLSelectElement | null => screen.queryByRole('combobox', { name: 'Service' }) as HTMLSelectElement | null
    function cloud(over: Partial<SpeechStatus['cloud']>): SpeechStatus {
      return { ...ON_DEVICE, cloud: { mode: 'always', setting: '', service: 'core', usable: true, providers: [], relay: RELAY, ...over } }
    }
    function serviceInfo(): string {
      fireEvent.click(screen.getByRole('button', { name: 'About Service' }))
      return screen.getByText(/Where cloud transcription sends the recording/).textContent ?? ''
    }

    it.each([
      ['a server with the relay and a Gemini key', RELAY, [G1]],
      ['a server with the relay, no Gemini key', RELAY, []],
      ['a server without the relay, with a Gemini key', NO_RELAY, [G1]],
      ['no relay and no Gemini key', NO_RELAY, []]
    ] as const)('offers the Service select whenever a mode is on, below the mode, on %s', (_label, relay, providers) => {
      settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'core' }
      speech = cloud({ setting: 'core', providers: [...providers], relay })
      const { rerender } = render(<FeaturesSettingsSection />)
      const select = serviceSelect()!
      expect(select.value).toBe('core')
      expect([...select.options].map((o) => o.text)).toEqual(['Cinna server', 'My Gemini key'])
      expect(cloudGroup().compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(cloudDisabled()).toBe(false)
      fireEvent.change(select, { target: { value: 'gemini' } })
      expect(setSetting).toHaveBeenLastCalledWith({ key: 'voiceCloudService', value: 'gemini' })
      // Off: nothing to choose, whatever is saved or offered.
      settings = { ...HEALTHY, voiceCloudService: 'core' }
      speech = cloud({ mode: 'off', setting: 'core', providers: [...providers], relay })
      rerender(<FeaturesSettingsSection />)
      expect(serviceSelect()).toBeNull()
    })

    it('reads nothing of the signed-in server: no name, no availability row, no minutes, the same text on every profile', () => {
      const states = [
        { relay: RELAY, providers: [G1] },
        { relay: NO_RELAY, providers: [G1] },
        { relay: { available: true, serverName: 'Other Corp' }, providers: [G1] }
      ]
      const seen = (['off', 'fallback', 'always'] as const).flatMap((mode) => {
        settings = { ...HEALTHY, voiceCloudTranscription: mode, voiceCloudService: 'core' }
        return [states.map(({ relay, providers }) => {
          speech = cloud({ mode, setting: 'core', providers, relay })
          const { container, unmount } = render(<FeaturesSettingsSection />)
          const text = `${container.textContent} | ${voiceDescription()}${mode === 'off' ? '' : ` | ${serviceInfo()}`}`
          expect(screen.queryByTestId('feature-voice-relay-usage')).toBeNull()
          expect(cloudDisabled()).toBe(false)
          unmount()
          return text
        })]
      })
      for (const texts of seen) {
        expect(new Set(texts).size).toBe(1)
        expect(texts[0]).not.toMatch(/Acme|Other Corp|not available|min left|monthly limit/)
      }
    })

    it.each([
      ['relay offered, a Gemini key', RELAY, [G1]],
      ['no relay, a Gemini key', NO_RELAY, [G1]],
      ['no relay, no key', NO_RELAY, []]
    ] as const)('turning a mode on from Off with no service saved saves the Cinna server first (%s)', async (_label, relay, providers) => {
      speech = cloud({ mode: 'off', usable: false, providers: [...providers], relay })
      render(<FeaturesSettingsSection />)
      chooseCloud('always')
      await waitFor(() => expect(setSetting.mock.calls.map((call) => call[0])).toEqual([
        { key: 'voiceCloudService', value: 'core' },
        { key: 'voiceCloudTranscription', value: 'always' }
      ]))
    })

    it('a failed service save leaves the mode Off', async () => {
      serviceSaveFails = true
      speech = cloud({ mode: 'off', providers: [G1] })
      render(<FeaturesSettingsSection />)
      chooseCloud('always')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(setSetting.mock.calls.map((call) => call[0])).toEqual([{ key: 'voiceCloudService', value: 'core' }])
    })

    it('saves only the mode when a service is already saved, or when turning it off', () => {
      settings = { ...HEALTHY, voiceCloudService: 'gemini' }
      speech = cloud({ mode: 'off', setting: 'gemini', service: 'gemini', providers: [G1] })
      const { rerender } = render(<FeaturesSettingsSection />)
      chooseCloud('fallback')
      expect(setSetting.mock.calls.map((call) => call[0])).toEqual([{ key: 'voiceCloudTranscription', value: 'fallback' }])
      setSetting.mockReset()
      settings = { ...HEALTHY, voiceCloudTranscription: 'always' }
      speech = cloud({ providers: [G1] })
      rerender(<FeaturesSettingsSection />)
      chooseCloud('off')
      expect(setSetting.mock.calls.map((call) => call[0])).toEqual([{ key: 'voiceCloudTranscription', value: 'off' }])
    })

    it.each([
      ['the relay offered', RELAY],
      ['no relay', NO_RELAY]
    ] as const)('a mode on with no service saved asks for one, with %s', (_label, relay) => {
      settings = { ...HEALTHY, voiceCloudTranscription: 'always' }
      speech = cloud({ usable: false, providers: [G1], relay })
      render(<FeaturesSettingsSection />)
      expect(serviceSelect()!.value).toBe('')
      expect(serviceSelect()!.options[0].text).toBe('Choose…')
      expect(voiceDescription()).toMatch(/No cloud service is chosen yet/)
      fireEvent.change(serviceSelect()!, { target: { value: 'gemini' } })
      expect(setSetting).toHaveBeenLastCalledWith({ key: 'voiceCloudService', value: 'gemini' })
    })

    it('keeps the user\'s pick, and shows the window\'s own pick at once, before main\'s status catches up', () => {
      settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'gemini' }
      speech = cloud({ setting: 'gemini', service: 'gemini', providers: [G1], relay: NO_RELAY })
      const { rerender } = render(<FeaturesSettingsSection />)
      expect(serviceSelect()!.value).toBe('gemini')
      settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'core' }
      rerender(<FeaturesSettingsSection />)
      expect(serviceSelect()!.value).toBe('core')
    })

    it('with the Cinna server as the service: no Gemini credential row and no provider picker', () => {
      settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'core' }
      speech = cloud({ setting: 'core', providers: [] })
      const { rerender } = render(<FeaturesSettingsSection />)
      expect(screen.queryByText('No Gemini credential')).toBeNull()
      speech = cloud({ setting: 'core', providers: [G1, G2] })
      rerender(<FeaturesSettingsSection />)
      expect(screen.queryByRole('combobox', { name: 'Gemini provider' })).toBeNull()
    })

    it('promises the signed-in account\'s server, never by name, and says a server without transcription is found out at dictation', () => {
      settings = { ...HEALTHY, voiceCloudTranscription: 'always', voiceCloudService: 'core' }
      speech = cloud({ setting: 'core', providers: [G1] })
      const { unmount } = render(<FeaturesSettingsSection />)
      const always = voiceDescription()
      expect(always).toMatch(/turned into text by your Cinna server \(the server of the account you are signed in to when you dictate\)/)
      expect(always).toMatch(/If that server does not offer transcription, the dictation says so/)
      expect(always).not.toMatch(/on this Mac|Google|Acme/)
      expect(serviceInfo()).toMatch(/Cinna server: to your Cinna server \(the server of the account you are signed in to when you dictate\)/)
      unmount()
      settings = HEALTHY
      speech = cloud({ mode: 'off', relay: NO_RELAY })
      render(<FeaturesSettingsSection />)
      const off = voiceDescription()
      expect(off).toMatch(/on this Mac/)
      expect(off).toMatch(/your Cinna server offers transcription, Cinna can offer to continue there; nothing is sent unless you agree/)
    })
  })
})

